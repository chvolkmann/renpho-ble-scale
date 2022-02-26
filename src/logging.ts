import { ISettingsParam, Logger, TLogLevelName } from "tslog";

const DEFAULT_LOGGER_SETTINGS: ISettingsParam = {
  displayFunctionName: false,
  displayFilePath: "hidden",
  minLevel: "info",
};

let loglevel: TLogLevelName = "trace";
export const setLogLevel = (level: TLogLevelName) => {
  loglevel = level;
  ROOT_LOGGER.setSettings({ minLevel: loglevel });
};

const ROOT_LOGGER = new Logger({
  ...DEFAULT_LOGGER_SETTINGS,
  minLevel: loglevel,
});

export const getLogger = (name: string, opts: ISettingsParam = {}) =>
  ROOT_LOGGER.getChildLogger({ name, ...DEFAULT_LOGGER_SETTINGS, ...opts });
