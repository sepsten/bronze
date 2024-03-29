import path from "path";
import { pathExists, hashTransformObject } from "./utils";
import { BronzeOperation, BronzeOperationType } from "./operation";

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

    if(this.images.hasOwnProperty(id)) {
      if(this.images[id].src !== src) {
        console.warn("Warning: extension change detected for " + id + ". Will use new extension: " + path.extname(src));
        this.images[id].src = src;
      }

      return this.images[id];
    } else
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
  src: string;
  versions: {
    [versionID: string]: BronzeImageVersion
  };

  // Metadata
  width?: number;
  height?: number;
  brightness?: number;
  dominant?: object;

  readonly pendingOps: BronzeOperation[];

  /**
   * @param id {string}
   * @param src {string}
   * @param versions
   * @param w {number} - Optional width indicator in pixels.
   * @param h {number} - Optional height indicator in pixels.
   */
  constructor(id: string, src: string, versions?: { [versionID: string]: BronzeImageVersion }, w?: number, h?: number, b?: number, d?: object) {
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

    if(typeof d === "object") {
      this.dominant = d;
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
      return new BronzeImage(id, data.src, data.versions, data.width, data.height, data.brightness, data.dominant);
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

    // Is this a new version?
    if(this.versions[versionId]) {
      // - We already have a version with the same ID.

      // Does a generated image already exist?
      if(await pathExists(this.versions[versionId].path)) {
        // - We already got a generated image.

        // Has the transform changed?
        if(transformHash !== this.versions[versionId].hash) {
          // - New transform.
          this.queueDeleteOperation(versionId, this.versions[versionId].path);
          this.versions[versionId].path = path; // Update path
          this.queueVersionOperation(versionId, transformObj);
        } else {
          // - Same transform.
          // Has the path changed?
          if(path !== this.versions[versionId].path) {
            // - The path has changed.
            // Rename.
            this.queueRenameOperation(versionId, path);
            //this.versions[versionId].path = path; // Update path
          }
          // - Transform and path are the same, no op.
        }
      } else {
        this.versions[versionId].path = path; // Update path
        this.queueVersionOperation(versionId, transformObj);
      }
    } else {
      // - This is a new version.
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

  private queueRenameOperation(versionId: string, newPath: string) {
    let op = new BronzeOperation(
      BronzeOperationType.RENAME,
      this,
      versionId,
      newPath
    );

    this.pendingOps.push(op);
  }

  /**
   * Adds a DELETE operation for the previous known image.
   *
   * @private
   * @param path {string}
   */
  private queueDeleteOperation(versionId: string, path: string) {
    let op = new BronzeOperation(
      BronzeOperationType.DELETE,
      this,
      versionId,
      path
    );

    this.pendingOps.push(op);
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
      versionId,
      this.versions[versionId].path,
      transform
    );

    // Keep a reference to the operation.
    this.versions[versionId].op = op;

    let self = this;
    op.promise.then((info) => {
      self.versions[versionId].width = info.width;
      self.versions[versionId].height = info.height;
    })
    .catch(() => {}); // Needed to avoid uncaught promise error.

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
    if(!this.brightness || !this.dominant) {
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
      dominant: this.dominant,
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
