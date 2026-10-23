# Homebrew cask for Zode for Mac. Copy to a tap (homebrew-zode/Casks/zode.rb) and fill in version and sha256
# from the release: `shasum -a 256 Zode-<version>-arm64.dmg`.
cask "zode" do
  version "1.0.1"
  sha256 "d1460bab3f6d3fc3df1cf775df5390136420028a6361e11879a90c30f58ec312"

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
