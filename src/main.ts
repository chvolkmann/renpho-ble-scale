import { Logger } from "tslog";

import { runMessageLoop } from "./RenphoScale";

runMessageLoop("A4:C1:38:D9:67:6A", false, (scale) => {
  const logger = new Logger({
    displayFunctionName: false,
    displayFilePath: "hidden",
    name: "Custom Code",
  });
  logger.info("Connected!");
  scale
    .on("measurement", (val) =>
      logger
        .getChildLogger({ name: "event:measurement" })
        .info(`${val.toFixed(2)}kg`)
    )
    .on("liveupdate", (val) =>
      logger
        .getChildLogger({ name: "event:liveupdate" })
        .info(`${val.toFixed(2)}kg`)
    );
}).catch(console.error);
