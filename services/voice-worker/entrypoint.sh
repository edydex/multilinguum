#!/bin/sh
set -eu

# Named volumes are created as root. Give the unprivileged worker ownership
# before it imports Librosa/Numba or downloads model weights into the cache.
install -d -o multilinguum -g multilinguum \
    /home/multilinguum/.cache \
    /var/lib/multilinguum/voices
chown -R multilinguum:multilinguum \
    /home/multilinguum/.cache \
    /var/lib/multilinguum/voices

exec gosu multilinguum "$@"
