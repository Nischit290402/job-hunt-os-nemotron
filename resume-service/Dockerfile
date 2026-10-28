# LaTeX image for the resume service. Matches the packages your Resume Optimizer bases use.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
      poppler-utils curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# fontawesome (the link icon) lives in the 1.7 GB texlive-fonts-extra; take just that package from CTAN instead.
RUN set -e; curl -fsSL -o /tmp/fa.zip https://mirrors.ctan.org/fonts/fontawesome.zip; \
    cd /tmp && unzip -q fa.zip; T=/usr/local/share/texmf; \
    mkdir -p $T/tex/latex/fontawesome $T/fonts/tfm/public/fontawesome $T/fonts/type1/public/fontawesome \
             $T/fonts/enc/dvips/fontawesome $T/fonts/map/dvips/fontawesome; \
    find /tmp/fontawesome -path '*doc*' -prune -o \( -name '*.sty' -o -name '*.fd' -o -name '*.tex' \) -print -exec cp {} $T/tex/latex/fontawesome/ \; ; \
    find /tmp/fontawesome -name '*.tfm' -exec cp {} $T/fonts/tfm/public/fontawesome/ \; ; \
    find /tmp/fontawesome -name '*.pfb' -exec cp {} $T/fonts/type1/public/fontawesome/ \; ; \
    find /tmp/fontawesome -name '*.enc' -exec cp {} $T/fonts/enc/dvips/fontawesome/ \; ; \
    find /tmp/fontawesome -name '*.map' -exec cp {} $T/fonts/map/dvips/fontawesome/ \; ; \
    rm -rf /tmp/fa.zip /tmp/fontawesome; mktexlsr $T; \
    updmap-sys --enable Map=fontawesome.map; \
    kpsewhich fontawesome.sty
RUN pip install --no-cache-dir pypdf==5.4.0
WORKDIR /app
COPY app.py ./
COPY assets ./assets
ENV PORT=8080
EXPOSE 8080
CMD ["python3", "app.py"]
