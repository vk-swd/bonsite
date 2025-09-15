
import CopyPlugin from "copy-webpack-plugin"

if (process.env.FRONTEND_DEPLOY_FOLDER === undefined) {
  throw new Error("FRONTEND_DEPLOY_FOLDER environment variable is not set");
}

export default {
    entry: './main.tsx',
    output: {
      path: process.env.FRONTEND_DEPLOY_FOLDER, //process.env.KAFKA_HOSTNAME
      filename: 'main.js',
    },
    module: {
      rules: [
        { 
          test: /\.(js|jsx|tsx|ts)$/,
          exclude: /node_modules/,
          use: [{
            loader: "babel-loader",
            options: {
              presets: ["@babel/preset-env", "@babel/preset-react", "@babel/preset-typescript"],
            },
          }]
        }
      ],
    },
    resolve: {
      symlinks: false, // Set to false to resolve modules to their symlinked location
      extensions: [".ts", ".tsx", ".js", ".jsx"],
      extensionAlias: {
        ".js": [".ts", ".tsx", ".js"],
        ".mjs": [".mts", ".mjs"]
      }
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'index.html', to: process.env.FRONTEND_DEPLOY_FOLDER }, // copies all files from public/ into dist/
        ],
      })
    ]
  };


// module.exports = {
//     entry: './main.ts',
//     output: {
//       path: process.env.FRONTEND_DEPLOY_FOLDER, //process.env.KAFKA_HOSTNAME
//       filename: 'main.js',
//     },
//     module: {
//       rules: [{ test: /\.ts$/, use: "ts-loader" }],
//     },
//     resolve: {
//       symlinks: false, // Set to false to resolve modules to their symlinked location
//       extensions: ['.ts', '.js'],
//     },
//     plugins: [
//       new CopyPlugin({
//         patterns: [
//           { from: 'index.html', to: process.env.FRONTEND_DEPLOY_FOLDER }, // copies all files from public/ into dist/
//         ],
//       })
//     ]
//   };