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
  RETRIEVE_SIZE,
  MEASURE_BRIGHTNESS
};

export default class BronzeOperation {
  readonly type: BronzeOperationType;
  private readonly image: BronzeImage;
  readonly targetPath?: string;
  readonly transform?: BronzeTransform;
  promise?: Promise<any>;

  constructor(type: BronzeOperationType, img: BronzeImage, target?: string, transform?: BronzeTransform) {
    this.type = type;
    this.image = img;
    this.targetPath = target;
    this.transform = transform;
  }

  /**
   * Start the operation if it hasn't and return its promise.
   */
  run(): Promise<any> {
    if(this.promise) return this.promise;

    switch(this.type) {
      case BronzeOperationType.GENERATE:
        this.promise = this.generateImageFile(); break;
      case BronzeOperationType.DELETE:
        this.promise = this.deleteImageFile(); break;
      case BronzeOperationType.RETRIEVE_SIZE:
        this.promise = this.retrieveSize(); break;
      case BronzeOperationType.MEASURE_BRIGHTNESS:
        this.promise = this.measureBrightness();
      default:
        this.promise = Promise.resolve();
    }

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
      await op.run(); // Won't trigger a re-run.

    let data = await sharp(this.image.versions[smallestId].path).toColorspace("lab").toBuffer();
    let stats = await sharp(data).stats();
    this.image.brightness = Math.round(stats.channels[0].mean/256*100);
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
function createDirIfMissing(path: string) {
  return new Promise((resolve, reject) => {
    // Check if folder exists.
    fs.access(path, fs.constants.F_OK, (err: Error) => {
      // If error, it doesn't exist.
      if(err) {
        fs.mkdir(path, { recursive: true }, (err: Error) => {
          reject(err);
        });
      }

      resolve();
    });
  });
}
