$IMAGE_NAME = "airhockey"
$DOCKER_USERNAME = "coolestcal3b"
$TAG = "latest"
$COMMIT_HASH = $(git rev-parse --short HEAD)

if (-not $COMMIT_HASH) {
	Write-Host "❌ Error: Not in a Git repository or no commits found."
	exit 1
}

Write-Host "Building the Docker image..."
$buildCmd = "docker build $buildArgs -t `"${DOCKER_USERNAME}/${IMAGE_NAME}:${TAG}`" -t `"${DOCKER_USERNAME}/${IMAGE_NAME}:${COMMIT_HASH}`" ."
Invoke-Expression $buildCmd

if ($LASTEXITCODE -ne 0) {
	Write-Host "❌ Error: Docker build failed."
	exit 1
}

Write-Host "Pushing the image to Docker Hub..."
docker push "${DOCKER_USERNAME}/${IMAGE_NAME}:${TAG}"

if ($LASTEXITCODE -ne 0) {
	Write-Host "❌ Error: Failed to push ${TAG} tag."
	exit 1
}

docker push "${DOCKER_USERNAME}/${IMAGE_NAME}:${COMMIT_HASH}"

if ($LASTEXITCODE -ne 0) {
	Write-Host "❌ Error: Failed to push ${COMMIT_HASH} tag."
	exit 1
}

Write-Host "✅ Done! Pushed ${DOCKER_USERNAME}/${IMAGE_NAME} with tags: ${TAG} and ${COMMIT_HASH}."
