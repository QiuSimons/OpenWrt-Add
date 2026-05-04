## openwrt-25.12 - Fast Build for Node.js Dependent Packages

When building packages that require Node.js on the OpenWrt branch, use the prebuilt Node.js feed instead of compiling Node.js from source. This approach significantly reduces build time and ensures compatibility with dependent packages.

```bash
# remove the default Node.js feed
rm -rf feeds/packages/lang/node

# clone the prebuilt Node.js feed (packages-25.12 branch)
git clone https://github.com/sbwml/feeds_packages_lang_node -b packages-25.12 feeds/packages/lang/node
```
