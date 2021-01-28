import path from "path";
import fs from "fs";
import glob from "glob";
import globParent from "glob-parent";
import fillTemplate from "es6-dynamic-template";
import ProgressBar from "progress";
import createDebug from "debug";

import * as constants from "./constants";
import BronzeImageRegistry from "./registry";
import { BronzeOperation, BronzeOperationType } from "./operation";

const debug = createDebug("bronze");

/**
 * Run all the transformations supplied.
 */
export default async function bronze(cfg: BronzeConfig, profile: string): Promise<object> {
  profile = profile || "DEFAULT";
  const ops: BronzeOperation[] = [], regs = {};

  // Read last result
  let lastResult: any;
  if(cfg.infoFile)
    try {
      lastResult = JSON.parse(fs.readFileSync(cfg.infoFile, { encoding: "utf8" }));
    } catch(e) {
      console.error("Could not parse info file " + cfg.infoFile + "\n - " + e.message);
      lastResult = false;
    }

  debug("Preparing operations...");

  // Loop through configuration array of objects.
  const profiles = cfg.profiles;
  for(const profileName in profiles) {
    let [profileOps, reg] = await prepareProfile(profiles[profileName], lastResult? lastResult[profileName] : undefined);
    debug("- profile " + profileName + ": " + profileOps.length + " ops");

    ops.push(...profileOps);
    regs[profileName] = reg;
  }

  // Dry runs stop here.
  if(cfg.dry) {
    console.log("Dry run. Total: " + ops.length + " ops.");
    for(const op of ops) {
      debug(BronzeOperationType[op.type] + " " + op.targetPath);
    }
    return;
  }

  // Wait for all transformations to be over.
  debug("Total: " + ops.length + " ops. Beginning...");

  const bar = new ProgressBar(":bar :current/:total", {total: ops.length, width: 60, complete: "▓", incomplete: "░"});

  // Execute all operations
  const opPromises = []
  for(const op of ops) {
    opPromises.push(
      op.run()
      .then(() => {
        bar.tick();
      })
      .catch(e => {
        console.error("Error: failed operation\n - type: " + BronzeOperationType[op.type] + "\n - target: " + op.targetPath + "\n - message: " + e.message);
      })
    );
  }

  // Wait for all operations to be completed
  await Promise.all(opPromises);

  // Create the export object
  let regObjs = {};
  for(let profileName in regs) {
    regObjs[profileName] = regs[profileName].toObject();
  }

  // Write the information JSON file used by the helper.
  return new Promise((resolve, reject) => {
    if(cfg.infoFile)
      fs.writeFile(cfg.infoFile, JSON.stringify(regObjs, null, '  '), (err) => {
        if(err) reject(err);
        else resolve();
      });
    else
      resolve();
  });
}




/**
 * Prepares a single profile. Returns an array of operations.
 */
async function prepareProfile(profile:BronzeProfile, savedResult?: any): Promise<[BronzeOperation[], BronzeImageRegistry]> {
  const ops = [];

  // Glob all source files.
  const sourcePaths: string[] = await new Promise((resolve, reject) => {
    glob(profile.src, (err: Error, matches: string[]) => {
      if(err) reject(err);
      else resolve(matches);
    });
  });

  // Extract the common denominator (base) from the glob pattern.
  const sourcePathBase = globParent(profile.src);

  let reg: BronzeImageRegistry;
  if(savedResult) {
    try {
      reg = BronzeImageRegistry.fromObject(savedResult);
    } catch(e) {
      throw e;
    }
  } else
    reg = new BronzeImageRegistry(sourcePathBase);

  // For each file, apply transforms and save to file.
  var sourceIndex = 0;
  for(const sourcePath of sourcePaths) {
    // Get an image instance (new or old).
    const img = reg.getImageFromSource(sourcePath);

    const sourcePathObj = path.parse(sourcePath),
          sourceFolder = path.relative(sourcePathBase, sourcePathObj.dir);

    // For each transform.
    for(const transformName in profile.transforms) {
      const transform = profile.transforms[transformName];

      // Resolve output path
      const destPathTemplate = path.join(profile.destFolder, transform.dest || constants.DEFAULTS.transformDest);
      const outputPathWOExt = fillTemplate(destPathTemplate, {
        sourceName: sourcePathObj.name,
        sourceFolder,
        sourceIndex,
        transformName
      });

      // Resolve formats
      const outputFormats = transform.formats || profile.formats || constants.DEFAULTS.formats;

      // Output formats
      for(const formatName in outputFormats) {
        // Check that the format is allowed using a global setting.
        if(constants.ALLOWED_FORMATS.includes(formatName)) {
          const outputPath = outputPathWOExt + "." + constants.FORMAT_EXTS[formatName];

          // Build operation object
          const transformObj = {
            formatName,
            formatOptions: outputFormats[formatName],
            resize: transform.resize
          };

          await img.addVersion(transformName, formatName, outputPath, transformObj);
        }
      }
    }

    // Brightness measure must be the last operation for one source image.
    if(profile.measureBrightness) img.queueBrightnessMeasure();

    ops.push(...img.unqueuePendingOps());

    sourceIndex++;
  }

  return [ops, reg];
}
