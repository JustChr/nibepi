#!/bin/bash
# Patches for node-red-contrib-nibepi/config_node.js
#
# 1. Demote "Heatpump is not supported" from error to debug — this message fires
#    for any pump that is not F730/F750 (defrost feature only), which is misleading.
#
# 2. Translate Swedish connection status messages to German.

TARGET=/home/pi/.node-red/node_modules/node-red-contrib-nibepi/config_node.js

set -e

sudo mount -o remount,rw /

sed -i "s/nibe\.log(\`Heatpump is not supported\`,'diagnostic','error')/nibe.log(\`Heatpump is not supported\`,'diagnostic','debug')/" "$TARGET"

sed -i "s/sendError('Kärnan',\`Nibe \${config\.system\.pump} är ansluten\`)/sendError('Kern',\`Nibe \${config.system.pump} ist verbunden\`)/" "$TARGET"

sed -i "s/sendError('Kärnan',\`Nibe \${config\.tcp\.pump} är ansluten\`)/sendError('Kern',\`Nibe \${config.tcp.pump} ist verbunden\`)/" "$TARGET"

echo "Patches applied. Verify:"
grep -n "Kärnan\|är ansluten\|'diagnostic','error'" "$TARGET" && echo "WARNING: some patterns still found" || echo "OK — all patterns replaced"
