const database = require("./database");
const { closePool } = require("./postgres");
module.exports = { ...database, closePool };
