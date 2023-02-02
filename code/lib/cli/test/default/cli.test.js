jest.mock('lodash-es', () => {
  const x = jest.requireActual('lodash');

  console.log({ x });
});

const run = require('../helpers');

describe('Default behavior', () => {
  it('suggests the closest match to an unknown command', () => {
    const { status, stderr, stdout } = run(['upgraed']);

    // Assertions
    expect(status).toBe(1);
    expect(stderr.toString()).toContain('Invalid command: upgraed.');
    expect(stdout.toString()).toContain('Did you mean upgrade?');
  });
});
