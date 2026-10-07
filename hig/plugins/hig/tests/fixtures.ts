/** A small SwiftUI app that breaks many guidelines at once. */
export const BAD_APP: Record<string, string> = {
  'Demo/DemoApp.swift': `import SwiftUI
import CoreLocation

@main
struct DemoApp: App {
    let location = CLLocationManager()
    init() {
        location.requestWhenInUseAuthorization()
    }
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.light)
        }
    }
}
`,
  'Demo/ContentView.swift': `import SwiftUI

struct ContentView: View {
    @State private var email = ""
    @State private var items = ["a", "b"]
    @State private var showInfo = false
    var body: some View {
        TabView {
            NavigationView {
                List {
                    ForEach(items, id: \\.self) { Text($0) }
                        .onDelete { items.remove(atOffsets: $0) }
                }
            }
            .tabItem { Text("1") }
            Text("Click here to start").tabItem { Text("2") }
            Text("3").tabItem { Text("3") }
            Text("4").tabItem { Text("4") }
            Text("5").tabItem { Text("5") }
            Text("6").tabItem { Text("6") }
        }
        VStack {
            Image("logo")
            Text("Fine print").font(.system(size: 9))
            TextField("Email", text: $email)
            Text("Go")
                .onTapGesture { withAnimation { showInfo.toggle() } }
                .foregroundColor(Color(red: 0.2, green: 0.3, blue: 0.4))
        }
        .sheet(isPresented: $showInfo) { Text("Info") }
    }
}
`,
  'Demo.xcodeproj/project.pbxproj': `// !$*UTF8*$!
{ buildSettings = { SDKROOT = iphoneos; INFOPLIST_KEY_UILaunchScreen_Generation = YES; }; }
`,
}

/** The same app, following the guidelines the checks can see. */
export const GOOD_APP: Record<string, string> = {
  'Demo/DemoApp.swift': `import SwiftUI

@main
struct DemoApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
`,
  'Demo/ContentView.swift': `import SwiftUI
import CoreLocation

struct ContentView: View {
    @Environment(\\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\\.dismiss) private var dismiss
    @State private var email = ""
    @State private var showInfo = false
    let location = CLLocationManager()
    var body: some View {
        NavigationStack {
            VStack {
                Image(systemName: "star")
                    .accessibilityLabel("Favorite")
                Text("Tap to start").font(.body)
                TextField("Email", text: $email)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                Button("Share location") {
                    location.requestWhenInUseAuthorization()
                    withAnimation(reduceMotion ? nil : .default) { showInfo.toggle() }
                }
                .foregroundStyle(.primary)
            }
            .navigationTitle("Home")
            .sheet(isPresented: $showInfo) { Button("Done") { dismiss() } }
        }
    }
}
`,
  'Demo/Info.plist': `<plist><dict><key>NSLocationWhenInUseUsageDescription</key><string>Shows places near you.</string></dict></plist>`,
  'Demo/PrivacyInfo.xcprivacy': '<plist><dict></dict></plist>',
  'Demo/Assets.xcassets/AppIcon.appiconset/Contents.json': '{ "images": [] }',
  'Demo/Localizable.xcstrings': '{ "strings": {} }',
  'Demo.xcodeproj/project.pbxproj': `{ buildSettings = { SDKROOT = iphoneos; INFOPLIST_KEY_UILaunchScreen_Generation = YES; }; }`,
}

/** A web page with the usual slips. */
export const BAD_WEB: Record<string, string> = {
  'index.html': `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
</head>
<body>
  <img src="hero.png">
  <div class="card" onclick="openCard()">Open</div>
  <input type="email" name="email">
</body>
</html>
`,
  'style.css': `body { font-size: 14px; color: #333; }
button:focus { outline: none; }
.btn { height: 30px; }
.card { animation: pop 1s; }
@keyframes pop { from { opacity: 0 } }
`,
}
