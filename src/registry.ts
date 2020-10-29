import path from "path";
import { pathExists, hashTransformObject } from "./utils";
import BronzeOperation from "./operation";
import { BronzeOperationType } from "./operation";

type BronzeImages = {
  [srcId: string]: BronzeImage
};

type BronzeImageVersion = {
  id: string,
  format: string;
  transform: string;
  path: string;
  hash: string;
  width?: number;
  height?: number;
};

export default class BronzeImageRegistry {
  private readonly basepath: string;

  /**
   * Images are indexed according to their source ID.
   * The image source ID is the source file's path starting from the basepath.
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
   */
  private addImage(id: string): BronzeImage {
    let img = new BronzeImage(id, path.join(this.basepath, id));
    this.images[id] = img;
    return img;
  }

  /**
   * Returns an image info object and checks that it exists.
   * Assumes that the source file actually exists.
   */
  getImageFromSource(src: string): BronzeImage {
    // Extract source ID (source file path starting from basepath).
    const srcId = path.relative(this.basepath, src);

    if(this.images.hasOwnProperty(srcId))
      return this.images[srcId];
    else
      return this.addImage(srcId);
  }

  toObject(): object {
    let images = {};
    for(let id in this.images) {
      images[id] = this.images[id].toObject();
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

  private queueVersionOperation(versionId: string, transform: BronzeTransform): void {
    let op = new BronzeOperation(
      BronzeOperationType.GENERATE,
      this,
      this.versions[versionId].path,
      transform
    );

    let self = this;
    op.completeCallback = (info) => {
      self.versions[versionId].width = info.width;
      self.versions[versionId].height = info.height;
    };

    this.pendingOps.push(op);
  }

  unqueuePendingOps(): BronzeOperation[] {
    return this.pendingOps;
  }

  queueBrightnessMeasure() {
    if(!this.brightness) {
      this.pendingOps.push(new BronzeOperation(BronzeOperationType.MEASURE_BRIGHTNESS, this));
    }
  }

  /**
   * Creates a JSON object for export.
   */
  toObject(): object {
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


/**
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
