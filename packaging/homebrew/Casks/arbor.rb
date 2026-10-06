cask "arbor" do
  arch arm: "arm64", intel: "amd64"

  version "0.2.0"
  sha256 arm:   "9a11f5e85b46337d5c262dca60e9840f90ba70f80ef200b9e1c19379f8b2b784",
         intel: "fb33e24df5ca41885a70badc7bf6b32ac2275dbdcfe45f3f0c4e35ba0010e4bb"

  url "https://github.com/stbenjam/arbor/releases/download/v#{version}/arbor_v#{version}_darwin_#{arch}.app.zip"
  name "Arbor"
  desc "Find and delete linked Git worktrees you no longer need"
  homepage "https://github.com/stbenjam/arbor"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "Arbor.app"

  zap trash: [
    "~/Library/Application Support/Arbor",
    "~/Library/Application Support/arbor/statistics.json",
    "~/Library/Preferences/io.github.stbenjam.arbor.plist",
    "~/Library/Saved Application State/io.github.stbenjam.arbor.savedState",
  ]

  caveats <<~EOS
    Arbor is ad-hoc signed, but not yet signed with an Apple Developer ID
    or notarized. macOS will refuse to open it the first time. After trying
    to open it, go to System Settings → Privacy & Security → Open Anyway.
    Only approve a download you trust.
  EOS
end
