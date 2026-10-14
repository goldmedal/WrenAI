# Build context contains the source-built wheel, locked/hash-exported requirements,
# metadata-input.json, metadata.py, worker.py and the pinned snapshot-helper.py.
FROM python@sha256:1847ca1d1bc792b4b58fff39c82c67942112e3e1ebc0ee1d06b9014873152ce7
COPY requirements.txt /opt/genbi/requirements.txt
COPY wheels/ /opt/genbi/wheels/
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: --find-links=/opt/genbi/wheels -r /opt/genbi/requirements.txt
COPY wrenai-0.13.0-py3-none-any.whl /opt/genbi/wrenai-0.13.0-py3-none-any.whl
RUN python -m pip install --no-cache-dir --no-deps /opt/genbi/wrenai-0.13.0-py3-none-any.whl && python -m pip check
COPY worker.py snapshot-helper.py metadata-input.json metadata.py /opt/genbi/
RUN groupadd --gid 1500 sandbox && useradd --uid 1500 --gid 1500 --create-home sandbox \
    && python /opt/genbi/metadata.py && chmod -R a+rX /opt/genbi \
    && mkdir -p /sandbox && chmod 1777 /sandbox
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /sandbox
