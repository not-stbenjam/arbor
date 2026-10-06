class Arbor < Formula
  desc "Manage Git worktrees"
  homepage "https://github.com/stbenjam/arbor"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/stbenjam/arbor/releases/download/v0.2.0/arbor_v0.2.0_darwin_arm64.tar.gz"
      sha256 "d5e3e9e7d607ece2e184cb3ffc5510d9f343b4206872c50917b701321fcad23d"
    end

    on_intel do
      url "https://github.com/stbenjam/arbor/releases/download/v0.2.0/arbor_v0.2.0_darwin_amd64.tar.gz"
      sha256 "98783cc3b24d305034378c8fdfd9025865e9c6c62c14368761dee8236b452492"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/stbenjam/arbor/releases/download/v0.2.0/arbor_v0.2.0_linux_arm64.tar.gz"
      sha256 "5b419420cc3f0d09c060bf97e99a8f6ba1eb4208b2e600cb9bdb7a3f50efffcb"
    end

    on_intel do
      url "https://github.com/stbenjam/arbor/releases/download/v0.2.0/arbor_v0.2.0_linux_amd64.tar.gz"
      sha256 "83e02457aba18d1770bd0836bd4dc4a0be919b2a77598f1aa7e8885b28352f55"
    end
  end

  def install
    bin.install "arbor"
    generate_completions_from_executable(bin/"arbor", "completion")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/arbor version")
    (testpath/"empty").mkpath
    system bin/"arbor", "list", "--path", testpath/"empty", "--json"
  end
end
