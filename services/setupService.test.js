const {expect, test} = require('@jest/globals')
const SetupService = require("./setupService");
const path = require("node:path");

test("parse a valid environment file with multiline contents", async () => {

  const testfile = path.resolve(__dirname, "test-data", "setupService-multiline.env");

  const service = new SetupService({envPath: testfile});

  const config = await service.loadConfig();

  expect(config).toHaveProperty("KEY1", "value1")
  expect(config).toHaveProperty("KEY2", "value2")
  expect(config).toHaveProperty("MULTILINE_KEY1", `This is line1
This is line2
This is line3`)
})

test("that no loaded configuration is populated in process.env", async () => {

  const testfile = path.resolve(__dirname, "test-data", "setupService-multiline.env");

  const service = new SetupService({envPath: testfile});

  const config = await service.loadConfig();

  expect(config).toHaveProperty("KEY1", "value1")
  expect(process.env).not.toHaveProperty("KEY1")
})
