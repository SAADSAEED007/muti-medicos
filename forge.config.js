const path = require('path');
const pkg = require('./package.json');

module.exports = {
  packagerConfig: {
    // Keep package.json `name` as PharmaSpot so existing installations continue
    // to use %APPDATA%\PharmaSpot. Only user-facing branding changes.
    executableName: 'Multi Medicos',
    icon: path.resolve(__dirname, 'assets/images/multi-medicos.ico'),
    asar: true,
    prune: true,
    win32metadata: {
      CompanyName: 'Multi Medicos',
      FileDescription: 'Multi Medicos Pharmacy Management System',
      InternalName: 'Multi Medicos',
      OriginalFilename: 'Multi Medicos.exe',
      ProductName: 'Multi Medicos'
    },
    ignore: [
      /^\/(?:out|release|coverage|release-builds|screenshots|tests|scripts|\.git|\.github)(?:\/|$)/,
      /^\/(?:gulpfile\.js|forge\.config\.js|jest\.config\.(?:js|ts)|build\.js|latest-yml\.js|CODE_OF_CONDUCT\.md|CONTRIBUTING\.md|README\.md|TODO|notes\.txt)$/,
      /\.log$/
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // Preserve the Squirrel package identity for in-place upgrades.
        name: pkg.name,
        title: 'Multi Medicos',
        authors: pkg.author,
        description: pkg.description,
        setupExe: `Multi-Medicos-${pkg.version}-Setup.exe`,
        setupIcon: path.resolve(__dirname, 'assets/images/multi-medicos.ico'),
        noMsi: true
      }
    }
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'SAADSAEED007',
          name: 'muti-medicos'
        },
        draft: true
      }
    }
  ]
};
