# Small LaTeX image for the resume service. Add packages your template needs to the apt line.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.py ./
COPY assets ./assets
ENV PORT=8080
EXPOSE 8080
CMD ["python3", "app.py"]
