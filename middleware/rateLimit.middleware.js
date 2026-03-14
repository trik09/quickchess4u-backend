import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const createRateLimiter = ({
  windowMs,
  max,
  message,
  keyPrefix,
  identifierFromReq,
}) => {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const identifierRaw =
        (typeof identifierFromReq === "function" ? identifierFromReq(req) : "") ??
        "";
      const identifier = String(identifierRaw).trim().toLowerCase();
      const ipKey = ipKeyGenerator(req);
      return `${keyPrefix}:${ipKey}:${identifier}`;
    },
    handler: (req, res, _next, options) => {
      const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
      return res.status(429).json({
        message,
        retryAfterSeconds,
      });
    },
  });
};

export const userLoginRateLimiter = createRateLimiter({
  windowMs: 1000,
  max: 3,
  message: "Too many login attempts. Please try again later.",
  keyPrefix: "rl:user-login",
  identifierFromReq: (req) => req.body?.email,
});

export const adminLoginRateLimiter = createRateLimiter({
  windowMs: 1000,
  max: 3,
  message: "Too many admin login attempts. Please try again later.",
  keyPrefix: "rl:admin-login",
  identifierFromReq: (req) => req.body?.email,
});

