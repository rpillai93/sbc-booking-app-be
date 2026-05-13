const isProd = process.env.NODE_ENV === "production";

const logger = {
  log: (...args) => {
    if (!isProd) logger.log(...args);
  },
  error: (...args) => {
    // always log errors regardless of environment
    console.error(...args);
  },
  info: (...args) => {
    if (!isProd) logger.log("[INFO]", ...args);
  },
};

module.exports = logger;
