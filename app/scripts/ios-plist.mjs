// After `npx cap add ios` / `cap sync ios`: teach the iOS app its banker:// link (wallet answers come back on it),
// which wallet apps it may open, and that it never asks for camera/location/etc. Safe to run more than once.
import { readFileSync, writeFileSync, existsSync } from 'fs'
const P = 'ios/App/App/Info.plist'
if (!existsSync(P)) { console.log('no ios project yet'); process.exit(0) }
let s = readFileSync(P, 'utf8')
const add = (key, xml) => { if (!s.includes(`<key>${key}</key>`)) s = s.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n${xml}\n</dict>\n</plist>\n`) }
add('CFBundleURLTypes', `\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>cash.banker.app</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>banker</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>`)
add('LSApplicationQueriesSchemes', `\t<array>\n\t\t<string>phantom</string>\n\t\t<string>solflare</string>\n\t</array>`)
add('UIUserInterfaceStyle', `\t<string>Dark</string>`)
add('UIStatusBarStyle', `\t<string>UIStatusBarStyleLightContent</string>`)
s = s.replace(/<key>UISupportedInterfaceOrientations<\/key>\s*<array>[\s\S]*?<\/array>/, '<key>UISupportedInterfaceOrientations</key>\n\t<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>')
writeFileSync(P, s); console.log('Info.plist updated')
