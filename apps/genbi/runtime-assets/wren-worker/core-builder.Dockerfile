FROM rust@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922
RUN apt-get update && apt-get install -y --no-install-recommends python3.11-dev python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3.11 -m venv /opt/build-python
COPY maturin-1.9.4-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl /opt/build/
RUN echo "68b7b833b25741c0f553b78e8b9e095b31ae7c6611533b3c7b71f84c2cb8fc44  /opt/build/maturin-1.9.4-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl" | sha256sum -c - && /opt/build-python/bin/pip install --no-index --no-deps /opt/build/maturin-1.9.4-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl
COPY source.tar.gz /opt/build/source.tar.gz
RUN echo "321e9c727cc58f4824d77c9a91d2c63886fdc4b094bd7a2f9b70aba9a144bd4b  /opt/build/source.tar.gz" | sha256sum -c - && tar -xzf /opt/build/source.tar.gz -C /opt/build
ENV CARGO_BUILD_JOBS=2 PYO3_PYTHON=/opt/build-python/bin/python
WORKDIR /opt/build/wren_core_py-0.7.1
RUN echo "463c08b70f5ba1f435e0860258e4bc0daf4a0831cbe728936229e4150eb0de7e  Cargo.lock" | sha256sum -c - && rustc --version > /opt/build/rust-version.txt && cc --version > /opt/build/compiler-version.txt && sha256sum Cargo.lock > /opt/build/cargo-lock.sha256
RUN /opt/build-python/bin/maturin build --release --locked --compatibility linux --out /opt/build/wheels > /opt/build/maturin.log 2>&1 || (tail -80 /opt/build/maturin.log; exit 1)
RUN sha256sum Cargo.lock > /opt/build/cargo-lock-after.sha256 && cmp /opt/build/cargo-lock.sha256 /opt/build/cargo-lock-after.sha256
