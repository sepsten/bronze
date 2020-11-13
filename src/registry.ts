import path from "path";
import { pathExists, hashTransformObject } from "./utils";
import BronzeOperation from "./operation";
import { BronzeOperationType } from "./operation";

type BronzeImages = {
  [srcId: string]: BronzeImage
};

export type BronzeImageVersion = {
  id: string,
  format: string;
  transform: string;
  path: string;
  hash: string;
  width?: number;
  height?: number;
  op?: BronzeOperation;
};

export default class BronzeImageRegistry {
  private readonly basepath: string;

  /**
   * Images are indexed according to their ID.
   * The image's ID is the source file's path starting from the basepath
   * without the extension.
   */
  private images: BronzeImages;

  /**
   * Instantiate an image registry from existing JSON data.
   */
  static fromObject(data: any): BronzeImageRegistry {
    if(!data.basepath)
      throw new Error("No 'basepath' property");

    if(!data.images)
      throw new Error("No 'image' property");

    const images: BronzeImages = {};
    for(let id in data.images) {
      try {
        let img = BronzeImage.fromObject(id, data.images[id]);
        images[img.id] = img;
      } catch(e) {}
    }

    return new BronzeImageRegistry(data.basepath, images);
  }

  constructor(basepath: string, images?: BronzeImages) {
    this.basepath = basepath;
    if(images) this.images = images;
    else this.images = {};
  }

  /**
   * Adds an image to the registry.
   *
   * @param id {string} - The image ID.
   */
  private addImage(id: string, src: string): BronzeImage {
    let img = new BronzeImage(id, src);
    this.images[id] = img;
    return img;
  }

  /**
   * Returns an image info object and checks that it exists.
   * Assumes that the source file actually exists.
   */
  getImageFromSource(src: string): BronzeImage {
    // Extract image ID (source file path starting from basepath without ext).
    const id = this.sourcePathToID(src);

    if(this.images.hasOwnProperty(id))
      return this.images[id];
    else
      return this.addImage(id, src);
  }

  /**
   * Converts a source path to an image ID.
   *
   * @param src {string} - The original source path.
   * @returns {string} - The image ID.
   */
  sourcePathToID(src: string): string {
    let pathO = path.parse(path.relative(this.basepath, src));
    return path.join(pathO.dir, pathO.name);
  }

  toObject(): object {
    let images = {};
    for(let id in this.images) {
      images[this.images[id].id] = this.images[id].toObject();
    }

    return {
      basepath: this.basepath,
      images
    };
  }
}

/**
 * "Diffing" class.
 */
export class BronzeImage {
  readonly id: string;
  readonly src: string;
  versions: {
    [versionID: string]: BronzeImageVersion
  };

  // Metadata
  width?: number;
  height?: number;
  brightness?: number;

  readonly pendingOps: BronzeOperation[];

  /**
   * @param id {string}
   * @param src {string}
   * @param versions
   * @param w {number} - Optional width indicator in pixels.
   * @param h {number} - Optional height indicator in pixels.
   */
  constructor(id: string, src: string, versions?: { [versionID: string]: BronzeImageVersion }, w?: number, h?: number, b?: number) {
    this.id = id;
    this.src = src;
    this.pendingOps = [];
    if(versions) this.versions = versions;
    else this.versions = {};

    if(!w || !h) {
      let op = new BronzeOperation(BronzeOperationType.RETRIEVE_SIZE, this);
      this.pendingOps.push(op);
    } else {
      this.width = w;
      this.height = h;
    }

    if(typeof b === "number") {
      this.brightness = b;
    }
  }

  /**
   * Instantiates a BronzeImage from JSON data.
   *
   * @param id {string} - The image's ID.
   * @param data {any} - The (parsed) JSON data.
   * @returns {BronzeImage}
   */
  static fromObject(id: string, data: any): BronzeImage {
    if(!data.src)
      throw new Error("No 'src' property");

    if(!data.versions)
      throw new Error("No 'versions' property");

    if(isImageVersionCollection(data.versions)) {
      return new BronzeImage(id, data.src, data.versions, data.width, data.height, data.brightness);
    } else {
      throw new Error("Malformed 'versions' property");
    }
  }

  /**
   * Adds a version (specific transform + specific format) to the image.
   *
   * @param transformName {string}
   * @param
   */
  async addVersion(transformName: string, formatName: string, path: string, transformObj: BronzeTransform): Promise<void> {
    const versionId = transformName + "-" + formatName,
          transformHash = hashTransformObject(transformObj);

    if(this.versions[versionId]) {
      // We already have a version with the same ID.
      this.versions[versionId].path = path;

      // Output file doesn't exist or the transform has changed.
      // => Must generate the version.
      if(transformHash !== this.versions[versionId].hash) {
        this.versions[versionId].hash = transformHash;
        this.queueVersionOperation(versionId, transformObj);
      } else if(!(await pathExists(path))) {
        this.queueVersionOperation(versionId, transformObj);
      }
    } else {
      this.versions[versionId] = {
        id: versionId,
        transform: transformName,
        format: formatName,
        path,
        hash: transformHash
      };

      this.queueVersionOperation(versionId, transformObj);
    }
  }

  /**
   * Adds a GENERATE operation for a specific image version-transform to the
   * instance's queue.
   *
   * @private
   * @param versionId {string} - The image version's ID (`transform-format`).
   * @param transform {BronzeTransform}
   */
  private queueVersionOperation(versionId: string, transform: BronzeTransform): void {
    let op = new BronzeOperation(
      BronzeOperationType.GENERATE,
      this,
      this.versions[versionId].path,
      transform
    );

    // Keep a reference to the operation.
    this.versions[versionId].op = op;

    let self = this;
    op.run().then((info) => {
      self.versions[versionId].width = info.width;
      self.versions[versionId].height = info.height;
    });

    this.pendingOps.push(op);
  }

  /**
   * Returns the instance's operation queue.
   *
   * @returns {BronzeOperation[]}
   */
  unqueuePendingOps(): BronzeOperation[] {
    // Should also remove the operations from the queue...
    return this.pendingOps;
  }

  /**
   * Tell the instance to queue a brightness measure operation if the
   * information is not already known.
   */
  queueBrightnessMeasure() {
    if(!this.brightness) {
      this.pendingOps.push(new BronzeOperation(BronzeOperationType.MEASURE_BRIGHTNESS, this));
    }
  }

  /**
   * Creates a JSON object for export.
   *
   * @returns {object}
   */
  toObject(): object {
    // We need to remove all references to operation instances in order to avoid
    // a circular structure.
    for(let versionId in this.versions) {
      delete this.versions[versionId].op;
    }

    return {
      id: this.id,
      src: this.src,
      width: this.width,
      height: this.height,
      brightness: this.brightness,
      versions: this.versions
    };
  };
}


/*
 * Type guards
 */

function isImageVersion(v: any): v is BronzeImageVersion {
  return typeof v === "object" && v.id && v.format && v.transform && v.path && v.hash;
}

function isImageVersionCollection(o: any): o is { [versionID: string]: BronzeImageVersion } {
  for(let versionId in o) {
    if(!isImageVersion(o[versionId]))
      return false;
  }
  return true;
}
