const http = require("http");
const express = require("express")();
const server = http.createServer(express);
const bodyParser = require("body-parser");
const rateLimit = require("express-rate-limit");
const pkg = require("./package.json");
const {app} = require('electron');
const fs = require('fs');
const path = require('path');
process.env.APPDATA = process.env.TEST_APPDATA || app.getPath('appData');
process.env.APPNAME = pkg.name;
const logoSource = path.join(__dirname, 'public', 'Multi Medicos Pharmacy Logo.png');
const logoDestination = path.join(process.env.APPDATA, pkg.name, 'uploads', 'multi-medicos-logo.png');
if (fs.existsSync(logoSource) && !fs.existsSync(logoDestination)) {
    fs.mkdirSync(path.dirname(logoDestination), { recursive: true });
    fs.copyFileSync(logoSource, logoDestination);
}
const PORT = Number(process.env.PORT || 3210);
const allowFallback = !process.env.PORT;
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window
});

console.log("Server started");

express.use(bodyParser.json());
express.use(bodyParser.urlencoded({ extended: false }));
express.use(limiter);

express.use(function (req, res, next) {
    const origin = req.headers.origin;
    const activePort = process.env.PORT || PORT;
    if (origin && origin !== "null" && origin !== `http://127.0.0.1:${activePort}` && origin !== `http://localhost:${activePort}`) {
        return res.sendStatus(403);
    }
    if (origin) res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
    res.header(
        "Access-Control-Allow-Headers",
        "Content-type,Accept,X-Access-Token,X-Key",
    );
    if (req.method == "OPTIONS") {
        res.status(200).end();
    } else {
        next();
    }
});

express.get("/", function (req, res) {
    res.send("POS Server Online.");
});

const usersApi = require("./api/users");
express.use("/api", usersApi.authorize);
express.use("/api/inventory", require("./api/inventory"));
express.use("/api/customers", require("./api/customers"));
express.use("/api/categories", require("./api/categories"));
express.use("/api/settings", require("./api/settings"));
express.use("/api/suppliers", require("./api/suppliers"));
express.use("/api/purchases", require("./api/purchases"));
express.use("/api/ledger", require("./api/ledger"));
express.use("/api/expenses", require("./api/expenses"));
express.use("/api/users", usersApi);
express.use("/api", require("./api/transactions"));

const ready = new Promise((resolve, reject) => {
    server.on('error', error => {
        if (error.code === 'EADDRINUSE' && allowFallback) {
            server.listen(0, '127.0.0.1');
        } else {
            reject(error);
        }
    });
    server.listen(PORT, '127.0.0.1', () => {
        process.env.PORT = String(server.address().port);
        console.log('Listening on PORT', process.env.PORT);
        resolve();
    });
});

/**
 * Restarts the server process.
 */
function restartServer() {
    server.close(() => {
        // Remove cached modules so require() reloads them
        Object.keys(require.cache).forEach(key => {
            if (key.includes('api') || key.endsWith('server.js')) {
                delete require.cache[key];
            }
        });
        // Re-require server.js to restart everything
        require('./server');
    });
}

module.exports = { restartServer, ready };
