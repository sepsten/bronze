interface BronzeConfig {
  infoFile?: string;
  profiles: object;
  dry?: boolean;
}

interface BronzeProfile {
  infoFile: string;
  src: string;
  destFolder: string;
  formats: {};
  transforms: object;
  measureBrightness?: boolean;
}

/*interface BronzeImage {
  id: string;
  src: string;
  width?: number;
  height?: number;
  brightness?: number;
  versions: Array<{
    path: string;
    format: string;
    width: number;
    height: number;
    transform: string;
  }>;
  indexByFormat?: object;
  indexByTransform?: object;
}*/

interface BronzeTransform {
  formatName: string;
  formatOptions: object;
  resize?: object;
  dest?: string;
}
