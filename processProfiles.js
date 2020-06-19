const fs = require("fs"),
      path = require("path"),
      glob = require("glob"),
      sharp = require("sharp"),
      globParent = require('glob-parent'),
      fillTemplate = require("es6-dynamic-template"),
      ProgressBar = require("progress");

/**
 * Default values and other constants.
 */
const ALLOWED_FORMATS = ["jpeg", "webp"];
const FORMAT_EXTS = { jpeg: "jpeg", webp: "webp" };
const DEFAULTS = {
  transformDest: "${sourceName}-${transformName}",
  formats: {
    jpeg: {}
  }
}



/**
 * Global progress bar…
 */
var PGBAR;



/**
 * Run all the transformations supplied.
 */
async function processProfiles(profiles) {
  // Global promise array to wait for everything to finish.
  const gPromises = [],
        gInfo = {};

  // Init progress bar
  PGBAR = new ProgressBar(':bar :current/:total :eta', {total: 0, width: 40, incomplete:'░', complete: '▓'});

  // Loop through configuration array of objects.
  for(profileName in profiles) {
    gPromises.push(processProfile(profiles[profileName]).then(info => {
      gInfo[profileName] = info;
    }));
  }

  // Wait for all transformations to be over.
  await Promise.all(gPromises);

  PGBAR = null;
  console.log('\n');

  return gInfo;
}




/**
 * Process a single profile.
 */
async function processProfile(profile) {
  // Glob all source files.
  let srcFiles = glob.sync(profile.src),
      srcBase = globParent(profile.src);

  const gInfo = {
    basepath: path.normalize(srcBase),
    images: {}
  };

  const gPromises = [];

  // For each file, apply transforms and save to file.
  for(const srcFile of srcFiles) {
    const srcPath = path.parse(srcFile),
          srcStream = sharp(),
          srcFolder = path.relative(srcBase, srcPath.dir),
          imageID = path.join(srcFolder, srcPath.name);

    // Store info
    const imageInfo = {
      versions: []
    };
    gInfo.images[imageID] = imageInfo;

    // Analyse image
    gPromises.push(getImageInfo(srcStream, profile.detectBrightness)
    .then(info => {
      imageInfo.width = info.width;
      imageInfo.height = info.height;
      if(profile.detectBrightness)
        imageInfo.brightness = info.brightness;
    }));

    // For each transform.
    for(const transformName in profile.transforms) {
      const transform = profile.transforms[transformName];

      // Resolve formats
      const outFormats = transform.formats || profile.formats || DEFAULTS.formats;

      // Resolve output path
      const destTemplate = path.join(profile.destFolder, transform.dest || DEFAULTS.transformDest);
      const outFile = fillTemplate(destTemplate, {
        sourceName: srcPath.name,
        sourceFolder: srcFolder,
        transformName
      });

      // Process file-transform combination; produces one image in different
      // formats.
      gPromises.push(
        transformImage(
          srcStream,
          outFile,
          outFormats,
          transform.resize
        ).then(transformedFiles => {
          // Add the transform name to each file.
          transformedFiles.forEach(f => {
            f.transform = transformName;
          });

          // Save image version info and create indexes.
          imageInfo.versions.push(...transformedFiles);
          indexImageVersions(imageInfo);
        })
      );
    }

    // Feed the source file to the Sharp stream (and its children).
    fs.createReadStream(srcFile).pipe(srcStream);
  }

  await Promise.all(gPromises);
  return gInfo;
}




/**
 * Applies a transform to a file and writes it to the disk in different formats.
 * @returns {Promise<Object>} An object containing the available formats as keys
 * and the output files' paths as values.
 */
async function transformImage(srcStream, outFile, outFormats, resizeOpt) {
  const gPromises = [];

  // Resizing
  let resizeStream = srcStream.clone().resize(resizeOpt);

  // If destination folder does not exist, create it with all parent folders.
  await createDirIfMissing(path.dirname(outFile));

  // Output formats
  for(const formatName in outFormats) {
    // Check that the format is allowed using a global setting.
    if(ALLOWED_FORMATS.includes(formatName)) {
      PGBAR.total++; PGBAR.tick(0);
      gPromises.push(
        writeOutputFormat(resizeStream, outFile, formatName, outFormats[formatName])
      );
    }
  }

  return Promise.all(gPromises);
}




/**
 * Saves an incoming stream as a file in a given format.
 * @returns {Promise<Object>} Returns an object describing the output file with
 * its path and some info.
 */
function writeOutputFormat(srcStream, outPath, formatMethod, opt) {
  return new Promise((resolve, reject) => {
    const outFile = outPath + "." + FORMAT_EXTS[formatMethod];
    const outStream = srcStream.clone()[formatMethod](opt).toFile(outFile, (err, info) => {
      if(err)
        reject(err);
      else {
        // Return an info object
        PGBAR.tick();
        resolve({
          path: outFile,
          format: formatMethod,
          width: info.width,
          height: info.height
        });
      }
    });
  });
}




/**
 * Creates a directory and its parents if they don't exist.
 */
function createDirIfMissing(path) {
  return new Promise((resolve, reject) => {
    // Check if folder exists.
    fs.access(path, fs.constants.F_OK, (err) => {
      // If error, it doesn't exist.
      if(err) {
        fs.mkdir(path, { recursive: true }, (err) => {
          reject(err);
        });
      }

      resolve();
    });
  });
}




/**
 * Gathers information on an image.
 */
async function getImageInfo(srcStream, shouldDetectBrightness) {
  const [ {height, width}, brightness ] = await Promise.all([
    srcStream.metadata(),
    shouldDetectBrightness && detectBrightness(srcStream)
  ]);

  return {
    height, width, ...(shouldDetectBrightness && {brightness})
  };
}



/**
 * Returns the average lightness of an image using the Lab colorspace.
 * On a scale from 0 (black) to 100 (white).
 */
async function detectBrightness(input) {
  // Create a new pipeline with .clone().
  PGBAR.total++; PGBAR.tick(0);
  let data = await input.clone().toColorspace("lab").toBuffer();
  let stats = await sharp(data).stats();
  PGBAR.tick();
  return Math.round(stats.channels[0].mean/256*100);
}



/**
 * Create indexes of image versions.
 * 1) Index by image format sorted by width (asc).
 * 2) Index by transform name.
 * @returns None.
 */
function indexImageVersions(info) {
  // 1. Index by format sorted by width.
  info.indexByFormat = {};
  for(let i = 0; i < info.versions.length; i++) {
    let v = info.versions[i];
    if(!info.indexByFormat.hasOwnProperty(v.format))
      info.indexByFormat[v.format] = [];

    // First, store two values: the index and the width.
    info.indexByFormat[v.format].push([i, v.width]);
  }

  for(const formatName in info.indexByFormat) {
    // Sort by width.
    info.indexByFormat[formatName].sort((a, b) => {
      return a[1] - b[1];
    });
    // Remove the width.
    for(let i = 0; i < info.indexByFormat[formatName].length; i++) {
      info.indexByFormat[formatName][i] = info.indexByFormat[formatName][i][0];
    }
  }

  // 2. Index by transform name.
  info.indexByTransform = {};
  for(let i = 0; i < info.versions.length; i++) {
    let v = info.versions[i];
    if(!info.indexByTransform.hasOwnProperty(v.transform))
      info.indexByTransform[v.transform] = {};

    // First, store two values: the index and the width.
    info.indexByTransform[v.transform][v.format] = i;
  }
}



// exports (Common JS)
module.exports = processProfiles;
