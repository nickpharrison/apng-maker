
const fs = require("fs");
const { Readable, Transform } = require("stream");
const crc32 = require('crc-32');

const pngSignature = Buffer.from('\x89PNG\r\n\x1A\n', 'ascii');
const emptyBuffer = Buffer.alloc(0);

const bufferToVisualString = (buf) => {
	return [...buf].map((code) => {
		if (code === 10) {
			return '\\n';
		}
		if (code === 13) {
			return '\\r';
		}
		if (code < 32 || code > 126) {
			const hex = code.toString(16).toUpperCase();
			return '\\x' + (hex.length === 1 ? '0' : '') + hex;
		}
		return String.fromCharCode(code);
	}).join('');
}

const assertSignature = (signature) => {
	if (pngSignature.equals(signature)) {
		return;
	}
	throw new Error(`A non-PNG image was supplied to the APNGMaker. The signature (encoded as ASCII) should have been "${bufferToVisualString(pngSignature)}" but instead was "${bufferToVisualString(signature)}"`);
}

const getImageHeaderChunk = (width, height, {bitDepth, colourType, compressionMethod, filterMethod, interlaceMethod}) => {

	const chunk = Buffer.allocUnsafe(25);
	chunk.writeUInt32BE(13, 0);                              // length of chunk data
	chunk.write('IHDR', 4);                                  // type of chunk
	chunk.writeUInt32BE(width, 8);                           // width
	chunk.writeUInt32BE(height, 12);                         // height
	chunk.writeUInt8(bitDepth, 16);                          // bit depth
	chunk.writeUInt8(colourType, 17);                        // colour type
	chunk.writeUInt8(compressionMethod, 18);                 // compression method
	chunk.writeUInt8(filterMethod, 19);                      // filter method
	chunk.writeUInt8(interlaceMethod, 20);                   // interlace method
	chunk.writeInt32BE(crc32.buf(chunk.slice(4, 21)), 21);   // crc
	return chunk;

}

const getAnimationControlChunk = (numberOfLoops, numberOfFrames) => {

	const chunk = Buffer.allocUnsafe(20);
	chunk.writeUInt32BE(8, 0);                               // length of chunk data
	chunk.write('acTL', 4);                                  // type of chunk
	chunk.writeUInt32BE(numberOfFrames, 8);                  // number of frames
	chunk.writeUInt32BE(numberOfLoops, 12);                  // number of times to loop
	chunk.writeInt32BE(crc32.buf(chunk.slice(4, 16)), 16);   // crc
	return chunk;

}

const getFrameControlChunk = (sequenceNumber, width, height, delay) => {

	const chunk = Buffer.allocUnsafe(38);
	chunk.writeUInt32BE(26, 0);                              // length of chunk data
	chunk.write('fcTL', 4);                                  // type of chunk
	chunk.writeUInt32BE(sequenceNumber, 8);                  // sequence number
	chunk.writeUInt32BE(width, 12);                          // width
	chunk.writeUInt32BE(height, 16);                         // height
	chunk.writeUInt32BE(0, 20);                              // x offset
	chunk.writeUInt32BE(0, 24);                              // y offset
	chunk.writeUInt16BE(delay, 28);                          // frame delay - fraction numerator
	chunk.writeUInt16BE(1000, 30);                           // frame delay - fraction denominator
	chunk.writeUInt8(1, 32);                                 // dispose mode
	chunk.writeUInt8(0, 33);                                 // blend mode
	chunk.writeInt32BE(crc32.buf(chunk.slice(4, 34)), 34);   // crc
	return chunk;

}

const getEndChunk = () => {

	const chunk = Buffer.allocUnsafe(12);
	chunk.writeUInt32BE(0, 0);                                // length of chunk data
	chunk.write('IEND', 4);                                   // type of chunk
	chunk.writeInt32BE(crc32.buf(chunk.slice(4, 8)), 8);      // crc
	return chunk;

}

class FrameStream extends Readable {

	constructor(stream, delay, isFirstImage) {

		super();

		if (delay == null) {
			if (!isFirstImage) {
				throw new Error('The `delay` of a frame can only be null if it is the first image added (to indicate it is a default image and not part of the animation)');
			}
		} else {
			if (typeof delay !== 'number' || isNaN(delay) || delay < 0 || delay > 65356) {
				throw new Error(`The \`delay\` of a frame must be a positive number less than 65356, not ${typeof delay === 'number' ? delay : typeof delay} (or it may be null for the first image added if it is only a default image and not part of the animation)`);
			}
			if (!Number.isInteger(delay)) {
				delay = Math.round(delay);
			}
		}

		this._stream = stream;
		this._delay = delay;
		this._isFirstImage = isFirstImage;

		this._nextSequenceNum = null;
		this._animationIhdrParameters = null;

		this._currentChunk = null;
		this._partialBeginning = null;
		this._crcLeftoverStillToCome = 0;

		this._signatureIsVerified = false;
		this._ihdrHasBeenRecieved = false;
		this._iendHasBeenRecieved = false;

	}

	_signalMore() {
		this.push(emptyBuffer);
	}

	setNextSequenceNum(nextSequenceNum) {
		if (typeof nextSequenceNum !== 'number' || !Number.isInteger(nextSequenceNum) || nextSequenceNum < 0) {
			throw new Error('Sequence number must be a non-negative integer');
		}
		this._nextSequenceNum = nextSequenceNum;
	}

	getNextSequenceNum() {
		if (this._nextSequenceNum == null) {
			throw new Error('Tried to fetch a frame sequence number before setting it');
		}
		return this._nextSequenceNum;
	}

	setIhdrParameters(animationIhdrParameters) {
		if (animationIhdrParameters == null && !this._isFirstImage) {
			throw new Error('Attempted to set null IHDR parameters for an image that was not the first');
		}
		this._animationIhdrParameters = animationIhdrParameters;
	}

	getIhdrParameters() {
		if (this._animationIhdrParameters == null) {
			throw new Error('Attempted to fetch a frame\'s IHDR parameters before they were set');
		}
		return this._animationIhdrParameters;
	}

	newChunk(startOfChunk) {

		if (this._nextSequenceNum == null) {
			throw new Error('A sequence number must be set before reading any data from a frame stream');
		}

		if (this._iendHasBeenRecieved) {
			throw new Error('An image supplied to the animation contained a chunk after the IEND chunk');
		}

		if (startOfChunk.length < 8) {
			this._partialBeginning = startOfChunk;
			return true;
		}

		const dataLength = startOfChunk.readUInt32BE(0);
		const type = startOfChunk.toString('ascii', 4, 8);

		this._currentChunk = {
			type: type,
			remainingDataLength: dataLength,
			streamingType: null,
			checkSum: 0
		}

		let data;

		switch (type) {
			case 'IHDR':
				if (this._currentChunk.remainingDataLength !== 13) {
					throw new Error(`An image had an IHDR chunk which specified a data length of ${this._currentChunk.remainingDataLength}, not 13`);
				}
				if (startOfChunk.length < 25) {
					this._partialBeginning = startOfChunk;
					this._currentChunk = null;
					return true;
				}

				this._ihdrHasBeenRecieved = true;

				const bitDepth = startOfChunk[16];
				const colourType = startOfChunk[17];
				const compressionMethod = startOfChunk[18];
				const filterMethod = startOfChunk[19];
				const interlaceMethod = startOfChunk[20];
				if (this._isFirstImage) {
					if (this._animationIhdrParameters != null) {
						throw new Error(`The initial image in the animation already had IHDR parameters set, when these should have been determined automatically`);
					}
					this._animationIhdrParameters = {bitDepth, colourType, compressionMethod, filterMethod, interlaceMethod}
				} else {
					if (this._animationIhdrParameters == null) {
						throw new Error(`No IHDR parameters were set for an animation image before they were required.`);
					}
					if (bitDepth !== this._animationIhdrParameters.bitDepth) {
						throw new Error(`The first image of the animation specified a bit depth of ${this._animationIhdrParameters.bitDepth} but a different image had a bit depth of ${bitDepth}. The bit depth must be consistent across all images in the animation.`);
					}
					if (colourType !== this._animationIhdrParameters.colourType) {
						throw new Error(`The first image of the animation specified a color type of ${this._animationIhdrParameters.colourType} but a different image had a color type of ${colourType}. The colour type must be consistent across all images in the animation.`);
					}
					if (compressionMethod !== this._animationIhdrParameters.compressionMethod) {
						throw new Error(`The first image of the animation specified a compression method of ${this._animationIhdrParameters.compressionMethod} but a different image had a compression method of ${compressionMethod}. The compression method must be consistent across all images in the animation.`);
					}
					if (filterMethod !== this._animationIhdrParameters.filterMethod) {
						throw new Error(`The first image of the animation specified a filter method of ${this._animationIhdrParameters.filterMethod} but a different image had a filter method of ${filterMethod}. The filter method must be consistent across all images in the animation.`);
					}
					if (interlaceMethod !== this._animationIhdrParameters.interlaceMethod) {
						throw new Error(`The first image of the animation specified an interlace method of ${this._animationIhdrParameters.interlaceMethod} but a different image had an interlace method of ${interlaceMethod}. The interlace method must be consistent across all images in the animation.`);
					}
				}
				if (crc32.buf(startOfChunk.slice(4, 21)) !== startOfChunk.readInt32BE(21)) {
					throw new Error('The IHDR chunk of an image in the animation was corrupt and the checksum of the IHDR chunk did not match what was specified');
				}
				if (this._delay == null) {
					if (!this._isFirstImage) {
						throw new Error('A delay must be specified for any image that is not the first image');
					}
				} else {
					const width = startOfChunk.readUInt32BE(8);
					const height = startOfChunk.readUInt32BE(12);
					const fctl = getFrameControlChunk(this._nextSequenceNum++, width, height, this._delay);
					this.push(fctl);
				}
				data = startOfChunk.slice(8);
				break;
			case 'IDAT':
				if (this._isFirstImage) {
					data = startOfChunk.slice(8);
					this._currentChunk.streamingType = 'IDAT';
				} else {
					data = startOfChunk.slice(4);
					data.writeUInt32BE(this._nextSequenceNum++, 0);
					this._currentChunk.streamingType = 'fdAT';
					this._currentChunk.remainingDataLength += 4; // Add four because the chunk has to start with the sequence number so the chunk is 4 bytes longer than before
				}
				break;
			case 'IEND':
				this._iendHasBeenRecieved = true;
				data = startOfChunk.slice(8);
				break;
			case 'PLTE':
				console.warn(new Error('An image that was supplied to the animation contained a PLTE chunk, which is not supported by APNGMaker. The output file will likely be corrupted due to mismatched colour palettes between frames. Try converting the frame images to a colour type that does not require a PLTE chunk before feeding them to the APNGMaker.'));
				data = startOfChunk.slice(8);
				this._currentChunk.streamingType = 'PLTE';
				break;
			default:
				data = startOfChunk.slice(8);
				break;
		}

		if (!this._ihdrHasBeenRecieved) {
			throw new Error('An image in the animation was corrupt and did not contain an IHDR chunk as the first chunk');
		}

		let doMore = true;

		if (this._currentChunk.streamingType) {

			const lengthAndType = Buffer.allocUnsafe(8);
			lengthAndType.writeUInt32BE(this._currentChunk.remainingDataLength, 0);
			lengthAndType.write(this._currentChunk.streamingType, 4);
			doMore = this.push(lengthAndType);
			this._currentChunk.checkSum = crc32.buf(lengthAndType.slice(4, 8), this._currentChunk.checkSum);
	
		}

		if (data.length !== 0) {
			doMore = this.processDataBasedOnLength(data);
		}

		return doMore;

	}

	dumpData(data, expectingToFinish) {
		this._currentChunk.remainingDataLength -= data.length;
		if (this._currentChunk.remainingDataLength === 0) {
			if (expectingToFinish === false) {
				throw new Error('Dumping data finished a chunk when we weren\'t expecting');
			}
			return true;
		}
		if (this._currentChunk.remainingDataLength < 0) {
			throw new Error('Dumping data discarded more than the current chunk');
		}
		if (expectingToFinish === true) {
			throw new Error('Dumping data didn\'t finish the chunk when we were expecting it to');
		}
		return true;
	}

	streamData(data, expectingToFinish) {
		this._currentChunk.checkSum = crc32.buf(data, this._currentChunk.checkSum);
		this._currentChunk.remainingDataLength -= data.length;
		let doMore = this.push(data);
		if (this._currentChunk.remainingDataLength === 0) {
			const checksum = Buffer.allocUnsafe(4);
			checksum.writeInt32BE(this._currentChunk.checkSum);
			doMore = this.push(checksum);
			this._currentChunk = null;
			if (expectingToFinish === false) {
				throw new Error('Streamed a chunk and finished it when not expecting');
			}
			return doMore;
		}
		if (this._currentChunk.remainingDataLength < 0) {
			throw new Error('Streamed more data in a chunk than we should have!!');
		}
		if (expectingToFinish === true) {
			throw new Error('Streamed a chunk and didn\'t finish it even though we were expecting to');
		}
		return doMore;
	}

	processDataBasedOnLength(data) {

		if (this._currentChunk == null) {
			throw new Error('processDataBasedOnLength was called when there\'s on current chunk left to stream');
		}

		this._streamOrDump = this._currentChunk.streamingType ? this.streamData : this.dumpData;

		const remainingLength = this._currentChunk.remainingDataLength;

		const leftoverBytesInData = data.length - remainingLength;

		let doMore;
		if (leftoverBytesInData < 0) { // If there is more data to stream/dump than we have available
			doMore = this._streamOrDump(data, false);
		} else if (leftoverBytesInData <= 4) { // If there is only just enough data to stream/dump (thanks to a checksum of 4 bytes)
			doMore = this._streamOrDump(data.slice(0, remainingLength), true);
			this.crcLeftoverStillToCome = leftoverBytesInData;
		} else { // If we have plenty of data to cover the leftover crc
			this._streamOrDump(data.slice(0, remainingLength), true);
			doMore = this.newChunk(data.slice(remainingLength + 4));
		}

		return doMore;

	}

	_read(size) {

		let doMore = true;
		while (doMore) {

			let input = this._stream.read();

			if (input == null) {
				if (this._stream.readable) {
					this._stream.once('readable', () => {
						this._signalMore();
					});
					this._stream.once('end', () => {
						this._signalMore();
					});
				} else {
					if (!this._iendHasBeenRecieved) {
						throw new Error('A stream for one image in the animation finished streaming before the IEND chunk was received');
					}
					this.push(null);
				}
				return;
			}

			if (this._partialBeginning != null) {
				input = Buffer.concat([this._partialBeginning, input]);
				this._partialBeginning = null;
			}

			if (!this._signatureIsVerified) {
				if (input.length < 8) {
					this._partialBeginning = input;
					return;
				}
				assertSignature(input.slice(0, 8));
				this._signatureIsVerified = true;
				input = input.slice(8);
			}

			if (this._crcLeftoverStillToCome > 0) {
				if (input.length <= this._crcLeftoverStillToCome) {
					this.crcLeftoverStillToCome -= input.length;
					return;
				}	
				input = input.slice(this._crcLeftoverStillToCome);
				this._crcLeftoverStillToCome = 0;
			}

			if (this._currentChunk == null || this._currentChunk.remainingDataLength === 0) {
				doMore = this.newChunk(input);
			} else {
				doMore = this.processDataBasedOnLength(input)
			}

		}

	}

}

class APNGMaker extends Readable {

	constructor(width, height, numberOfLoops, numberOfFrames) {

		super();

		if (!Number.isInteger(width) || width < 1) {
			throw new Error(`width must be a positive integer, not ${typeof width === 'number' ? width : typeof width}`);
		}
		if (!Number.isInteger(height) || height < 1) {
			throw new Error(`height must be a positive integer, not ${typeof height === 'number' ? height : typeof height}`);
		}
		if (!Number.isInteger(numberOfLoops) || numberOfLoops < 0) {
			throw new Error(`numberOfLoops must be a non-negative integer, not ${typeof numberOfLoops === 'number' ? numberOfLoops : typeof numberOfLoops}`);
		}
		if (!Number.isInteger(numberOfFrames) || numberOfFrames < 1) {
			throw new Error(`numberOfFrames must be a positive integer, not ${typeof numberOfFrames === 'number' ? numberOfFrames : typeof numberOfFrames}`);
		}

		this._width = width;
		this._height = height;

		this._numberOfLoops = numberOfLoops;
		this._numberOfFrames = numberOfFrames;

		this._totalFramesAdded = 0;

		this._firstFrameHasBeenAdded = false;
		this._addingFramesHasEnded = false;
		this._inputStreams = [];

		this._initialChunksHaveBeenSent = false;
		this._preInitialBuffer = null;
		this._animationIhdrParameters = null;

		// Set as local var so "this." can be used for other methods in the function below
		const self = this;

		this._current = {
			readStream: null,
			fctlSequenceNum: 0,
			next: function() {
				if (this.readStream instanceof FrameStream) {
					this.fctlSequenceNum = this.readStream.getNextSequenceNum();
					if (self._animationIhdrParameters == null) {
						self._animationIhdrParameters = this.readStream.getIhdrParameters();
					}
				}
				const potential = self._inputStreams.shift();
				if (potential == null) {
					this.readStream = null;
				} else {
					this.readStream = potential;
					if (this.readStream instanceof FrameStream) {
						this.readStream.setNextSequenceNum(this.fctlSequenceNum);
						this.readStream.setIhdrParameters(self._animationIhdrParameters);
					}
					this.num++;
				}
			}
		}

	}

	_read() {

		let keepGoing = true;
		while (keepGoing) {
			if (this._current.readStream == null) {
				this._current.next();
				if (this._current.readStream == null) {
					if (this._addingFramesHasEnded) {
						this.push(null);
					}
					return;
				}
			}
			if (!this._current.readStream.readable) {
				this._current.next();
				continue;
			}
			const input = this._current.readStream.read();
			if (input == null) {

				this._current.readStream.once('readable', () => {
					this._signalMore();
				});
				this._current.readStream.once('end', () => {
					this._signalMore();
				});

				keepGoing = false;

			} else if (this._initialChunksHaveBeenSent) {

				keepGoing = this.push(input);

			} else {

				let preInitialBuffer = this._preInitialBuffer == null ? input : Buffer.concat([this._preInitialBuffer, input]);

				if (preInitialBuffer.length < 33) { // (Size of signature and IHDR combined)
					this._preInitialBuffer = preInitialBuffer;
					continue;
				}

				this.push(pngSignature);
				this.push(getImageHeaderChunk(this._width, this._height, this._current.readStream.getIhdrParameters()));
				this.push(getAnimationControlChunk(this._numberOfLoops, this._numberOfFrames));
				keepGoing = this.push(preInitialBuffer);

				this._initialChunksHaveBeenSent = true;

			}

		}

	}

	_signalMore() {
		this.push(emptyBuffer);
	}

	// Stream, filepath string, or buffer
	addFrame(input, delay) {

		if (this._addingFramesHasEnded) {
			throw new Error('Cannot add a frame after the end method has been called');
		}

		const frameStream = this._getFrameStream(input);

		this._inputStreams.push(new FrameStream(frameStream, delay, !this._firstFrameHasBeenAdded));

		this._firstFrameHasBeenAdded = true;

		this._totalFramesAdded += 1;

		this._signalMore();

	}

	_getFrameStream(input) {

		if (typeof input === 'string') {
			return fs.createReadStream(input);
		}

		if (typeof input === 'object') {

			if (input instanceof Readable || input instanceof Transform) {
				return input;
			}

			if (input instanceof Buffer) {
				const bufferStream = new Readable();
				bufferStream.push(bufferStream);
				bufferStream.push(null);
				return bufferStream;
			}

		}

		throw new Error(`Invalid input type of frame "${typeof input}". Should be an input stream or file path string (or a Buffer, but this is the slowest)`);

	}

	finish(silent = false) {

		if (this._addingFramesHasEnded) {
			return;
		}

		if (this._totalFramesAdded !== this._numberOfFrames && !silent) {
			if (this._initialChunksHaveBeenSent) {
				console.warn(new Error(`A corrupt APNG has been produced. The total number of frames specified (${this._numberOfFrames}) is different to the total number of frames that were added (${this._totalFramesAdded}).`));
			} else {
				console.warn(new Error(`A corrupt APNG would have been produced if the streaming had already begun by the time \`end\` was called. The total number of frames specified (${this._numberOfFrames}) is different to the total number of frames that were added (${this._totalFramesAdded}).`));
				this._numberOfFrames = this._totalFramesAdded;
			}
		}

		const finalStream = new Readable({read: function(size) {this.push(null);}});
		finalStream.push(getEndChunk());
		finalStream.push(null);
		this._inputStreams.push(finalStream);
		this._addingFramesHasEnded = true;

		this._signalMore();

	}

}

module.exports.APNGMaker = APNGMaker;
