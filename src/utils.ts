import fs from "fs";
import crypto from "crypto";
import stringify from "safe-stable-stringify";

export function hashTransformObject(obj: BronzeTransform): string {
  const h = crypto.createHash("md5");
  h.update(stringify(obj));
  return h.digest('hex');
};

export async function pathExists(path: fs.PathLike): Promise<boolean> {
  return new Promise((resolve, _reject) => {
    fs.access(path, fs.constants.F_OK, (err: Error) => {
      // If error, it doesn't exist.
      if(err)
        resolve(false);
      else
        resolve(true);
    });
  });
}
