const {expect, test} = require('@jest/globals')
const {ThumbnailService} = require("./thumbnailService");
const {promises: fs} = require("fs");
const os = require("node:os");
const path = require("node:path");


async function createTempDirectory() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'paperless-ai-thumbnailservicetest-'));
}

test("thumbnail service downloads a existing thumbnail through the provided paperless service", async () => {

  const paperlessServiceMock = {
    getThumbnailImage: jest.fn((id) => {
      // Mock implementation of the method for the given id
      return Promise.resolve(`Mock thumbnail for id: ${id}`);
    }),
  };

  let thumbnailBasedir = await createTempDirectory();
  const service = new ThumbnailService({
    thumbnailBasedir: thumbnailBasedir,
    paperlessService: paperlessServiceMock
  });

  let img = await service.getThumbnailPath('4711')

  expect(img).toBe(path.join(thumbnailBasedir, '4711.png'));
  expect(paperlessServiceMock.getThumbnailImage).toHaveBeenCalledWith('4711');


})


test("thumbnail service returns null if no thumbnail is found", async () => {

    const paperlessServiceMock = {
    getThumbnailImage: jest.fn((id) => {
      // simulating a "not found"
      return null;
    }),
  };

  const service = new ThumbnailService({
    thumbnailBasedir: await createTempDirectory(),
    paperlessService: paperlessServiceMock
  });

  let img = await service.getThumbnailPath('4711')

  expect(img).toBeNull();
  expect(paperlessServiceMock.getThumbnailImage).toHaveBeenCalledWith('4711');
})