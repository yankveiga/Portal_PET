// Express 4 precisa encaminhar rejeicoes de handlers async ao middleware de erro.
function installAsyncHandlers(app) {
  const wrap = (handler) => {
    if (Array.isArray(handler)) return handler.map(wrap);
    if (typeof handler !== "function" || handler.length === 4) return handler;
    return function handleAsync(req, res, next) {
      try {
        Promise.resolve(handler(req, res, next)).catch(next);
      } catch (error) { next(error); }
    };
  };
  for (const method of ["get", "post", "put", "patch", "delete", "use"]) {
    const register = app[method];
    app[method] = function registerAsync(...args) {
      return register.apply(this, args.map(wrap));
    };
  }
}
module.exports = { installAsyncHandlers };
