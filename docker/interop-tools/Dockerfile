# External gRPC clients for the protocol interop suites.
#
# The interop suites check Connectum's gRPC Server Reflection and Health with
# clients that are not built on Connect: grpcurl and grpc_health_probe use
# grpc-go, buf curl uses buf's own stack. Every client is pinned here, by image
# digest or by a release checksum, so a check gives the same result on every
# machine and an update is a deliberate edit of this file.
#
# Build with `node scripts/interop-tools.mjs`.

FROM fullstorydev/grpcurl:v1.9.3@sha256:085e183ca334eb4e81ca81ee12cbb2b2737505d1d77f5e33dabc5d066593d998 AS grpcurl
FROM bufbuild/buf:1.73.0@sha256:75d8f756f0919dcded71e67968a91adfe55fe4dd62c4900c57bbfcd7fe625608 AS buf

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

COPY --from=grpcurl /bin/grpcurl /usr/local/bin/grpcurl
COPY --from=buf /usr/local/bin/buf /usr/local/bin/buf

# The checksum is the one published in the release's checksums.txt; a binary
# that does not match fails the build.
ADD --chmod=755 --checksum=sha256:9193773627d3ed5a0fabe37ed81264b4a8e9d5a2156ce09fb6010caaabb0f06b \
    https://github.com/grpc-ecosystem/grpc-health-probe/releases/download/v0.4.57/grpc_health_probe-linux-amd64 \
    /usr/local/bin/grpc_health_probe
