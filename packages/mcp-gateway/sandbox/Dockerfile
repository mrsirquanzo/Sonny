FROM python:3.11.15-slim-bookworm@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba

ARG ANALYSIS_UID=65532
ARG ANALYSIS_GID=65532

ENV HOME=/tmp \
    MPLCONFIGDIR=/tmp/matplotlib \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/tmp/.cache

COPY requirements.txt /tmp/requirements.txt

RUN python -m pip install \
        --no-cache-dir \
        --no-deps \
        --only-binary=:all: \
        --require-hashes \
        -r /tmp/requirements.txt \
    && python -m pip check \
    && python -c "import Bio, matplotlib, numpy, pandas, pyarrow, scipy" \
    && python -m pip uninstall --yes pip setuptools wheel \
    && rm -rf \
        /root/.cache \
        /tmp/requirements.txt \
        /usr/local/bin/pip* \
        /usr/local/lib/python3.11/ensurepip \
        /usr/local/lib/python3.11/site-packages/pip*

RUN groupadd --gid "${ANALYSIS_GID}" sonny-analysis \
    && useradd --uid "${ANALYSIS_UID}" --gid "${ANALYSIS_GID}" \
        --no-create-home --shell /usr/sbin/nologin sonny-analysis \
    && mkdir /work \
    && chown "${ANALYSIS_UID}:${ANALYSIS_GID}" /work

WORKDIR /work
USER 65532:65532

CMD ["python", "-c", "print('sonny-analysis image ready')"]
