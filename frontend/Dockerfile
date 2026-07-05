# Stage 1: we don't need to build anything (plain HTML/JS)
# so we go straight to the Nginx serving stage

FROM nginx:alpine

# Copy our HTML/CSS/JS files into the folder nginx serves by default
COPY src/ /usr/share/nginx/html/

# Replace the default nginx config with ours (which adds the /api proxy)
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# nginx starts automatically — no CMD needed (it's in the base image)
