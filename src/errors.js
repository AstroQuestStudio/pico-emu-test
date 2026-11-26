/** Raised when the Python code run on the board ends with an exception. */
export class PythonError extends Error {
  /**
   * @param {string} stderr traceback printed by MicroPython
   * @param {string} stdout output produced before the exception
   */
  constructor(stderr, stdout) {
    const lines = stderr.trim().split('\n');
    super(lines[lines.length - 1] || 'Python error');
    this.name = 'PythonError';
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/** Raised when the board does not answer within the wall-clock limit. */
export class TimeoutError extends Error {
  constructor(message, partialOutput = '') {
    super(message);
    this.name = 'TimeoutError';
    this.partialOutput = partialOutput;
  }
}

/** Raised when the firmware needs something the emulator does not provide (for example the second core). */
export class EmulationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmulationError';
  }
}
