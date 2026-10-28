# LaTeX image for the resume service. Matches the packages your Resume Optimizer bases use.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
      poppler-utils curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# fontawesome (the link icon) lives in the 1.7 GB texlive-fonts-extra; take just that package from CTAN instead.
RUN set -e; curl -fsSL -o /tmp/fa.zip https://mirrors.ctan.org/install/fonts/fontawesome.tds.zip; \
    unzip -q /tmp/fa.zip -d /usr/local/share/texmf; rm /tmp/fa.zip; \
    mktexlsr /usr/local/share/texmf; \
    updmap-sys --enable Map=fontawesome.map || updmap-sys --enable Map fontawesome.map; \
    kpsewhich fontawesome.sty
RUN pip install --no-cache-dir pypdf==5.4.0
WORKDIR /app
COPY app.py ./
COPY assets ./assets
ENV PORT=8080
EXPOSE 8080
CMD ["python3", "app.py"]
