import sharp from "sharp";
import fs from "fs";
import path from "path";
import createDebug from "debug";
import { BronzeImage } from "./registry";

const debug = createDebug("bronze:op");

export enum BronzeOperationType {
  NOOP,
  GENERATE,
  DELETE,
  RENAME,
  RETRIEVE_SIZE,
  MEASURE_BRIGHTNESS
};

export class BronzeOperation {
  readonly type: BronzeOperationType;
  private readonly image: BronzeImage;
  readonly version?: string;
  readonly targetPath?: string;
  readonly transform?: BronzeTransform;
  private callback?: (err?: Error, data?: any) => void;
  readonly promise: Promise<any>;

  constructor(type: BronzeOperationType, img: BronzeImage, version?: string, target?: string, transform?: BronzeTransform) {
    this.type = type;
    this.image = img;
    this.version = version;
    this.targetPath = target;
    this.transform = transform;

    // The callback mechanism allows to have a promise before the operation is
    // actually run.
    const self = this;
    this.promise = new Promise((resolve, reject) => {
      self.callback = (err?: Error, data?: any) => {
        if(err) reject(err);
        else resolve(data);
      };
    });
  }

  /**
   * Start the operation if it hasn't and return its promise.
   */
  run(): Promise<any> {
    let p: Promise<any>;
    switch(this.type) {
      case BronzeOperationType.GENERATE:
        p = this.generateImageFile(); break;
      case BronzeOperationType.DELETE:
        p = this.deleteImageFile(); break;
      case BronzeOperationType.RENAME:
        p = this.renameImageFile(); break;
      case BronzeOperationType.RETRIEVE_SIZE:
        p = this.retrieveSize(); break;
      case BronzeOperationType.MEASURE_BRIGHTNESS:
        p = this.measureBrightness(); break;
      default:
        p = Promise.resolve();
    }

    // Send the result to the operation's promise through the callback.
    p.then((d: any) => this.callback(null, d)).catch((e: Error) => this.callback(e));

    return this.promise;
  }

  private deleteImageFile(): Promise<void> {
    let self = this;
    return new Promise((resolve, reject) => {
      fs.unlink(self.targetPath, (err: Error) => {
        if(err) reject(err);
        else resolve();
      });
    });
  }

  private renameImageFile(): Promise<void> {
    let self = this;
    return new Promise((resolve, reject) => {
      fs.rename(self.image.versions[this.version].path, self.targetPath, (err: Error) => {
        if(err) reject(err);
        else {
          debug("Renamed " + self.image.versions[this.version].path + " to " + self.targetPath);
          self.image.versions[this.version].path = self.targetPath;
          resolve();
        }
      });
    });
  }

  private async generateImageFile(): Promise<object> {
    const sourceStream = getSourceStream(this.image.src);
    const transformedStream = applyTransforms(this, sourceStream);

    // Write output file
    await createDirIfMissing(path.dirname(this.targetPath));
    let self = this;
    let p: Promise<object> = new Promise((resolve, reject) => {
      transformedStream[self.transform.formatName](self.transform.formatOptions).toFile(self.targetPath, (err: Error, info: {}) => {
        if(err) {
          debug("Couldn't write " + self.targetPath);

          // Return an object describing the error?
          reject(err);
        }
        else {
          debug("Wrote " + self.targetPath);

          // Return an info object?
          resolve(info);
        }
      });
    });

    return p;
  }

  private async retrieveSize(): Promise<void> {
    let data = await this.getSourceStream(true).metadata();
    this.image.width = data.width;
    this.image.height = data.height;
  }

  /**
   * Warning! Brightnness measures MUST be performed after all image generation
   * operations because it will use the smallest sample.
   *
   * @returns {Promise<void>}
   */
  private async measureBrightness(): Promise<void> {
    // Find smallest version
    let smallestWidth: number = null, smallestId = null;
    for(let versionId in this.image.versions) {
      if(this.image.versions[versionId].width < smallestWidth || smallestWidth === null) {
        smallestWidth = this.image.versions[versionId].width;
        smallestId = versionId;
      }
    }

    // Wait for the image to be generated
    let op: BronzeOperation;
    if(op = this.image.versions[smallestId].op)
      await op.promise;

    let data = await sharp(this.image.versions[smallestId].path).toColorspace("lab").toBuffer();
    let stats = await sharp(data).stats();
    this.image.brightness = Math.round(stats.channels[0].mean/256*100);
    this.image.dominant = stats.dominant;
    debug(this.image.brightness + " " + this.image.dominant)
  }

  private getSourceStream(noClone?: boolean): sharp.Sharp {
    return getSourceStream(this.image.src, noClone);
  }
}

const sourceStreamsCache = {};

/**
 * Creates a source stream or fetches it from cache.
 * Not sure if this is any good as Sharp already caches files.
 */
function getSourceStream(path: string, noClone?: boolean): sharp.Sharp {
  if(typeof noClone === "undefined") noClone = false;

  if(sourceStreamsCache.hasOwnProperty(path)) {
    if(noClone) return sourceStreamsCache[path];
    else return sourceStreamsCache[path].clone();
  } else {
    const stream = sharp(path);
    sourceStreamsCache[path] = stream;
    return stream;
  }
}

/**
 * Configures image transform based on the `op.transform` property.
 * For now, only `resize` is supported.
 */
function applyTransforms(op: BronzeOperation, stream: sharp.Sharp) {
  if(op.transform.hasOwnProperty("resize")) {
    return stream.resize(op.transform.resize);
  } else {
    return stream;
  }
}

/**
 * Creates a directory and its parents if they don't exist.
 */
function createDirIfMissing(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if folder exists.
    fs.access(path, fs.constants.F_OK, (err: Error) => {
      // If error, it doesn't exist.
      if(err) {
        fs.mkdir(path, { recursive: true }, (err: Error) => {
          reject(err);
        });
      }

      resolve(null);
    });
  });
}
