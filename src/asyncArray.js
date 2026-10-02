// Sequencia preservada para escritas e verificacoes de permissao com curto-circuito.
async function map(items, callback) {
  const result = [];
  for (let i = 0; i < items.length; i += 1) result.push(await callback(items[i], i, items));
  return result;
}
async function filter(items, callback) {
  const result = [];
  for (let i = 0; i < items.length; i += 1) if (await callback(items[i], i, items)) result.push(items[i]);
  return result;
}
async function some(items, callback) {
  for (let i = 0; i < items.length; i += 1) if (await callback(items[i], i, items)) return true;
  return false;
}
async function every(items, callback) {
  for (let i = 0; i < items.length; i += 1) if (!await callback(items[i], i, items)) return false;
  return true;
}
async function find(items, callback) {
  for (let i = 0; i < items.length; i += 1) if (await callback(items[i], i, items)) return items[i];
}
async function forEach(items, callback) {
  for (let i = 0; i < items.length; i += 1) await callback(items[i], i, items);
}
module.exports = { map, filter, some, every, find, forEach };
