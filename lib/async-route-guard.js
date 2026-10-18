"use strict";

// Express 4 does not forward rejected async handlers to its error middleware.
// Install this before registering routes; preserve error-handler arity and router objects.
function installAsyncRouteGuard(target) {
  for (const method of ["use", "get", "post", "put", "patch", "delete", "all", "head", "options"]) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function (...args) {
      return original.apply(this, args.map(_wrap));
    };
  }
  return target;
}

function _wrap(handler) {
  if (Array.isArray(handler)) return handler.map(_wrap);
  if (typeof handler !== "function" || handler.constructor?.name !== "AsyncFunction") return handler;
  if (handler.length === 4) {
    return function (err, req, res, next) {
      Promise.resolve().then(() => handler(err, req, res, next)).catch(next);
    };
  }
  return function (req, res, next) {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
}

module.exports = { installAsyncRouteGuard };
