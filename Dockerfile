FROM registry.anylabel.name/labeling-app/backend/labeling:base
COPY . /app
RUN pnpm install -r --prod --frozen-lockfile
RUN pnpm run build
CMD ["pnpm", "-v"]
