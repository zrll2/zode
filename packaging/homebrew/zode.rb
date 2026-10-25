# Homebrew cask for Zode for Mac. Copy to a tap (homebrew-zode/Casks/zode.rb) and fill in version and sha256
# from the release: `shasum -a 256 Zode-<version>-arm64.dmg`.
cask "zode" do
  version "1.3.1"
  sha256 "23b20a445847014fc656b0a334451a4565c98b2d3a5285845fba1549c30c4416"

  url "https://github.com/zrll2/zode/releases/download/v#{version}/Zode-#{version}-arm64.dmg"
  name "Zode"
  desc "Control ZCode from your phone"
  homepage "https://github.com/zrll2/zode"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "Zode.app"

  zap trash: [
    "~/.zode",
    "~/Library/Caches/dev.zode.mac",
    "~/Library/Caches/zode-mac-updater",
  ]
end
