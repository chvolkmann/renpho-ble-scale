import { runMessageLoop } from "./RenphoScale";

runMessageLoop("A4:C1:38:D9:67:6A", {
  once: false,
  onConnect: (scale) => {
    console.log("Connected!");
    scale
      .on("liveupdate", (val) => console.log(`[*] ${val.toFixed(2)}kg`))
      .on("measurement", (val) => console.log(`--> ${val.toFixed(2)}kg`));
  },
  loglevel: "info",
}).catch(console.error);
