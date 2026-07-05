# Start from an official Python image (slim = smaller size)
FROM python:3.12-slim

# Set the working directory inside the container
WORKDIR /app

# Copy requirements first (Docker caches this layer, so it won't re-install
# packages every time you change your code — only when requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the service files
COPY . .

# Tell Docker this container listens on port 8001
EXPOSE 8001

# The command that runs when the container starts
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
