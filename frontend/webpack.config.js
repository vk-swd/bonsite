
const CopyPlugin = require("copy-webpack-plugin");

if (process.env.FRONTEND_DEPLOY_FOLDER === undefined) {
  throw new Error("FRONTEND_DEPLOY_FOLDER environment variable is not set");
}

module.exports = {
    entry: './main.ts',
    output: {
      path: process.env.FRONTEND_DEPLOY_FOLDER, //process.env.KAFKA_HOSTNAME
      filename: 'main.js',
    },
    module: {
      rules: [{ test: /\.ts$/, use: "ts-loader" }],
    },
    resolve: {
      symlinks: false, // Set to false to resolve modules to their symlinked location
      extensions: ['.ts', '.js'],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'index.html', to: process.env.FRONTEND_DEPLOY_FOLDER }, // copies all files from public/ into dist/
        ],
      })
    ]
  };