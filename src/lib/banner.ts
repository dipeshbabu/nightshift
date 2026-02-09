import { detectPlatform, getCpuName, getGpuName } from "./platform";
import { getNightshiftVersion } from "./constants";

const BIRD_PIXELS = [
  "..HHHHHHHHH..",
  ".GLLLHHHLLLG.",
  "HHLLKLLLKLLHH",
  "HHLLKLOOKLLHH",
  "HHLLLOWOLLLHH",
  "HHLLLLOLLLLHH",
  "HHHHHHHHHHHHH",
  ".HHHHHHHHHHH.",
  "..GGG...GGG..",
];

const BIRD_ANSI_COLORS: Record<string, string> = {
  G: "\x1b[38;2;78;128;25m",   // #4E8019
  H: "\x1b[38;2;108;155;33m",  // #6C9B21
  L: "\x1b[38;2;247;241;116m", // #F7F174
  K: "\x1b[38;2;34;34;34m",    // #222222
  O: "\x1b[38;2;250;158;40m",  // #FA9E28
  W: "\x1b[38;2;250;203;64m",  // #FACB40
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function renderBirdBanner(): void {
  const platform = detectPlatform();
  const version = getNightshiftVersion();
  const title = `Nightshift ${version}`;
  const cpu = getCpuName();
  const gpu = getGpuName();

  const info = [
    `${platform.os} ${platform.arch}`,
    cpu,
    // Only show GPU if it's different from CPU
    ...(gpu && !cpu.includes(gpu) && !gpu.includes("Apple M") ? [gpu] : []),
  ];

  const titleRow = 3; // position title near middle
  const infoStartRow = titleRow + 1;

  for (let i = 0; i < BIRD_PIXELS.length; i++) {
    const row = BIRD_PIXELS[i];
    let line = "";
    let lastColor = "";
    for (const cell of row) {
      if (cell === ".") {
        if (lastColor) {
          line += RESET;
          lastColor = "";
        }
        line += " ";
      } else {
        const color = BIRD_ANSI_COLORS[cell] || "";
        if (color !== lastColor) {
          line += color;
          lastColor = color;
        }
        line += "█";
      }
    }
    if (lastColor) line += RESET;

    // Add title and info to the right of the bird
    if (i === titleRow) {
      line += "  " + title;
    } else if (i >= infoStartRow && i - infoStartRow < info.length) {
      line += "  " + DIM + info[i - infoStartRow] + RESET;
    }

    console.log(line);
  }
  console.log();
}
