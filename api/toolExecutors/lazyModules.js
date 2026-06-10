const lazyModules = new Map();

function loadLazyModule(key, loader) {
  if (!lazyModules.has(key)) lazyModules.set(key, loader());
  return lazyModules.get(key);
}

function createLazyModuleProxy(key, loader) {
  return new Proxy({}, {
    get(_target, prop) {
      const mod = loadLazyModule(key, loader);
      const value = mod[prop];
      return typeof value === 'function' ? value.bind(mod) : value;
    },
    has(_target, prop) {
      return prop in loadLazyModule(key, loader);
    },
    ownKeys() {
      return Reflect.ownKeys(loadLazyModule(key, loader));
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Object.getOwnPropertyDescriptor(loadLazyModule(key, loader), prop);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    }
  });
}

module.exports = {
  createLazyModuleProxy,
  loadLazyModule
};
