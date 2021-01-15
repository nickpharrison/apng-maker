
const stream = require("stream");
const fs = require("fs");
const crc32 = require('crc-32');

const getImageHeaderChunk = (width, height) => {

	const chunk = Buffer.allocUnsafe(25);
	chunk.writeUInt32BE(13, 0);                                // length of chunk data
	chunk.write('IHDR', 4);                                    // type of chunk
	chunk.writeUInt32BE(width, 8);                             // width
	chunk.writeUInt32BE(height, 12);                           // height
	chunk.writeUInt8(8, 16);                                   // bit depth
	chunk.writeUInt8(6, 17);                                   // colour type
	chunk.writeUInt8(0, 18);                                   // compression method
	chunk.writeUInt8(0, 19);                                   // interlace method
	chunk.writeUInt8(0, 20);                                   // interlace method
	chunk.writeInt32BE(crc32.buf(chunk.slice(4, 21)), 21);     // crc
	return chunk;

}

const getAnimationControlChunk = (numberOfLoops, numberOfFrames) => {

	const chunk = Buffer.allocUnsafe(20);
	chunk.writeUInt32BE(8, 0);                                 // length of chunk data
	chunk.write('acTL', 4);                                    // type of chunk
	chunk.writeUInt32BE(numberOfFrames, 8);                    // number of frames
	chunk.writeUInt32BE(numberOfLoops, 12);                    // number of times to loop
	chunk.writeInt32BE(crc32.buf(chunk.slice(4, 16)), 16);     // crc
	return chunk;

}

const getFrameControlChunk = (sequenceNumber, width, height) => {

	const chunk = Buffer.allocUnsafe(38);
	chunk.writeUInt32BE(26, 0);                                // length of chunk data
	chunk.write('fcTL', 4);                                    // type of chunk
	chunk.writeUInt32BE(sequenceNumber, 8);                    // sequence number
	chunk.writeUInt32BE(width, 12);                            // width
	chunk.writeUInt32BE(height, 16);                           // height
	chunk.writeUInt32BE(0, 20);                                // x offset
	chunk.writeUInt32BE(0, 24);                                // y offset
	chunk.writeUInt16BE(1, 28);                                // frame delay - fraction numerator
	chunk.writeUInt16BE(2, 30);                                // frame delay - fraction denominator
	chunk.writeUInt8(1, 32);                                   // dispose mode
	chunk.writeUInt8(0, 33);                                   // blend mode
	chunk.writeInt32BE(crc32.buf(chunk.slice(4, 34)), 34);     // crc
	return chunk;

}

const getEndChunk = () => {

	const chunk = Buffer.allocUnsafe(12);
	chunk.writeUInt32BE(0, 0);                                     // length of chunk data
	chunk.write('IEND', 4);                                        // type of chunk
	chunk.writeUInt32BE(crc32.buf(chunk.slice(4, 8)) >>> 0, 8);    // crc
	return chunk;

}

class FrameStream extends stream.Readable {

	// fctlSequenceNumber should be null for frames that are only part of the default image
	constructor(stream, fctlSequenceNum) {

		super({
			read: function(size) {
				this.pushNext(size);
			}
		});

		this.stream = stream;
		this.fctlSequenceNum = fctlSequenceNum;

		this.currentChunk = null;
		this.partialBeginning = null;
		this.crcLeftoverStillToCome = 8; // Used to ignore the signature

		this.width = null;
		this.height = null;

	}

	signalMore() {
		this.push(Buffer.from([]));
	}

	newChunk(startOfChunk) {

		if (startOfChunk.length < 8) {
			this.partialBeginning = startOfChunk;
			return true;
		}

		const length = startOfChunk.readUInt32BE(0);
		const type = startOfChunk.toString('ascii', 4, 8);

		this.currentChunk = {
			type: type,
			remainingDataLength: length,
			streamingType: null,
			checkSum: 0
		}

		let data;

		switch (type) {
			case 'IHDR':
				if (this.fctlSequenceNum != null) {
					if (startOfChunk.length < 16) {
						this.partialBeginning = startOfChunk;
						this.currentChunk = null;
						return true;
					}
					const width = startOfChunk.readUInt32BE(8);
					const height = startOfChunk.readUInt32BE(12);
					const fctl = getFrameControlChunk(this.fctlSequenceNum, width, height);
					this.push(fctl);
				}
				data = startOfChunk.slice(8);
			break;
			case 'IDAT':
				if (this.fctlSequenceNum == null || this.fctlSequenceNum === 0) {
					data = startOfChunk.slice(8);
					this.currentChunk.streamingType = 'IDAT';
				} else {
					data = startOfChunk.slice(4);
					data.writeUInt32BE(this.fctlSequenceNum + 1, 0);
					this.currentChunk.streamingType = 'fdAT';
					this.currentChunk.remainingDataLength += 4; // Add for because the chunk has to start with the sequence number
				}
			break;
			default:
				data = startOfChunk.slice(8);
			break;
		}

		let doMore;

		if (this.currentChunk.streamingType) {
			doMore = this.newStreamingChunk(data, this.currentChunk.streamingType);
		} else {
			doMore = this.processDataBasedOnLength(data);
		}

		return doMore;

	}

	newStreamingChunk(startOfData, type) {

		const lengthAndType = Buffer.allocUnsafe(8);
		lengthAndType.writeUInt32BE(this.currentChunk.remainingDataLength, 0);
		lengthAndType.write(type, 4);
		let doMore = this.push(lengthAndType);
		this.currentChunk.checkSum = crc32.buf(lengthAndType.slice(4, 8), this.currentChunk.checkSum);

		if (startOfData.length === 0) { // No point continuing with an empty data
			return doMore;
		}

		doMore = this.processDataBasedOnLength(startOfData);

		return doMore;

	}

	dumpData(data, expectingToFinish) {
		this.currentChunk.remainingDataLength -= data.length;
		if (this.currentChunk.remainingDataLength === 0) {
			if (expectingToFinish === false) {
				throw new Error('Dumping data finished a chunk when we weren\'t expecting');
			}
			return true;
		}
		if (this.currentChunk.remainingDataLength < 0) {
			throw new Error('Dumping data discarded more than the current chunk');
		}
		if (expectingToFinish === true) {
			throw new Error('Dumping data didn\'t finish the chunk when we were expecting it to');
		}
		return true;
	}

	streamData(data, expectingToFinish) {
		this.currentChunk.checkSum = crc32.buf(data, this.currentChunk.checkSum);
		this.currentChunk.remainingDataLength -= data.length;
		let doMore = this.push(data);
		if (this.currentChunk.remainingDataLength === 0) {
			const checksum = Buffer.allocUnsafe(4);
			checksum.writeInt32BE(this.currentChunk.checkSum);
			doMore = this.push(checksum);
			this.currentChunk = null;
			if (expectingToFinish === false) {
				throw new Error('Streamed a chunk and finished it when not expecting');
			}
			return doMore;
		}
		if (this.currentChunk.remainingDataLength < 0) {
			throw new Error('Streamed more data in a chunk than we should have!!');
		}
		if (expectingToFinish === true) {
			throw new Error('Streamed a chunk and didn\'t finish it even though we were expecting to');
		}
		return doMore;
	}

	processDataBasedOnLength(data) {

		if (this.currentChunk == null) {
			throw new Error('processDataBasedOnLength was called when there\'s on current chunk left to stream');
		}

		this._streamOrDump = this.currentChunk.streamingType ? this.streamData : this.dumpData;

		const remainingLength = this.currentChunk.remainingDataLength;

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

	pushNext(size) {

		let input = this.stream.read();

		if (input == null) {
			if (this.stream.readable) {
				this.stream.once('readable', () => {
					this.signalMore();
				});
				this.stream.once('end', () => {
					this.signalMore();
				});
			} else {
				this.push(null);
			}
			return;
		}

		if (input.length <= this.crcLeftoverStillToCome) {
			this.crcLeftoverStillToCome -= input.length;
			return;
		}

		if (this.crcLeftoverStillToCome > 0) {
			input = input.slice(this.crcLeftoverStillToCome);
			this.crcLeftoverStillToCome = 0;
		}

		if (this.partialBeginning != null) {
			input = Buffer.concat([this.partialBeginning, input]);
			this.partialBeginning = null;
		}

		let doMore;
		if (this.currentChunk == null || this.currentChunk.remainingDataLength === 0) {
			doMore = this.newChunk(input);
		} else {
			doMore = this.processDataBasedOnLength(input)
		}

		if (doMore) {
			this.pushNext();
		}

	}

}

class APNGMaker {

	constructor(width, height, numberOfLoops, numberOfFrames) {

		if (numberOfFrames != null) {
			if (!Number.isInteger(numberOfFrames) || numberOfFrames < 1) {
				throw new Error('numberOfFrames must be a positive integer, if not null/undefined');
			}
		}

		this._width = width;
		this._height = height;

		this._numberOfLoops = numberOfLoops;
		this._numberOfFrames = numberOfFrames;

		this._fctlsequenceNum = 0;
		this._totalframesadded = 0;

		this._addingframeshasended = false;
		this._defaultimageadded = false;
		this._inputstreams = [];

		this._initialstreamHasBeenSent = false;

		// Add stream for signature
		const signatureAndIHDRAndacTLStream = new stream.Readable({
			read: function(size) {
				if (this._initialstreamHasBeenSent) {
					this.push(null);
					return;
				}
				this.push(Buffer.from('\x89PNG\r\n\x1A\n', 'ascii'));
				this.push(getImageHeaderChunk(self._width, self._height));
				this.push(getAnimationControlChunk(self._numberOfLoops, self._numberOfFrames));
				this.push(null);
				self._initialstreamHasBeenSent = true;
			}
		});
		this._inputstreams.push(signatureAndIHDRAndacTLStream);

		// Set as local var so "this." can be used for other methods in the function below
		const self = this;

		const current = {
			readStream: null,
			num: null,
			partialChunk: null,
			next: function() {
				const potential = self._inputstreams.shift();
				if (potential == null) {
					this.readStream = null;
				} else {
					this.readStream = potential;
					this.num++;
				}
			}
		}

		this._readstream = new stream.Readable({
			read: function(size) {

				let keepGoing = true;
				while (keepGoing) {
					if (current.readStream == null) {
						current.next();
						if (current.readStream == null) {
							if (self._addingframeshasended) {
								this.push(null);
							}
							return;
						}
					}
					if (!current.readStream.readable) {
						current.next();
						continue;
					}
					const input = current.readStream.read();
					if (input == null) {

						const signalMore = () => {
							this.push(Buffer.from([]));
						}
						current.readStream.once('readable', () => {
							signalMore();
						});
						current.readStream.once('end', () => {
							signalMore();
						});

						keepGoing = false;

					} else {

						keepGoing = this.push(input);

					}

				}

			}
		});

	}

	_newInput() {

	}

	getReadStream() {
		return this._readstream;
	}

	// Stream, filepath string, or buffer
	addFrame(input) {

		if (this._addingframeshasended) {
			throw new Error('Cannot add a frame after the end method has been called');
		}

		const frameStream = this._getFrameStream(input);

		this._inputstreams.push(new FrameStream(frameStream, this._fctlsequenceNum));

		this._fctlsequenceNum += 2;
		this._totalframesadded += 1;

		// Signal that more data is available
		this._readstream.push(Buffer.from([]));

	}

	addDefaultFrame(input, includeAsFrame = false) {

		if (this._defaultimageadded) {
			throw new Error('Cannot add multiple default frames');
		}

		if (this._addingframeshasended) {
			throw new Error('Cannot add a default frame after the end method has been called');
		}

		if (this._fctlsequenceNum !== 0) {
			throw new Error('Cannot add a default frame after normal frames have been added');
		}

		let fctlSequenceNum;
		if (includeAsFrame) {
			fctlSequenceNum = this._fctlsequenceNum++;
			this._totalframesadded += 2;
		} else {
			fctlSequenceNum = null
		}

		const fctlSequenceNum = includeAsFrame ? this._fctlsequenceNum++ : null;

		this._defaultimageadded = true;
		const frameStream = this._getFrameStream(input);
		this._inputstreams.push(new FrameStream(frameStream, fctlSequenceNum));
		
		// Signal that more data is available
		this._readstream.push(Buffer.from([]));

	}

	_getFrameStream(input) {

		if (typeof input === 'string') {
			return fs.createReadStream(input);
		}

		if (typeof input === 'object') {

			if (input instanceof stream.Readable || input instanceof stream.Transform) {
				return input;
			}

			if (input instanceof Buffer) {
				const bufferStream = new stream.Readable();
				bufferStream.push(bufferStream);
				bufferStream.push(null);
				return bufferStream;
			}

		}

		throw new Error(`Invalid input type of frame "${typeof input}". Should be an input stream or file path string (or a Buffer, but this is the slowest)`);

	}

	end(silent = false) {

		if (!this._defaultimageadded) {
			throw new Error('Cannot end APNG before a default image has been added. Consider using the first frame as a default frame too.');
		}

		if (this._addingframeshasended) {
			return;
		}

		if (this._totalframesadded !== this._numberOfFrames && !silent) {
			if (this._initialstreamHasBeenSent) {
				console.warn(new Error('A corrupt APNG has been produced. The total number of frames specified is different to the total number of frames that were added.'));
			} else {
				this._numberOfFrames = this._totalframesadded;
				console.warn(new Error('A corrupt APNG would have been produced if the streaming had already begun by the time `end` was called. The total number of frames specified is different to the total number of frames that were added.'));
			}
		}

		const finalStream = new stream.Readable({read: function(size) {return null}});
		finalStream.push(getEndChunk());
		finalStream.push(null);
		this._inputstreams.push(finalStream);
		this._addingframeshasended = true;

		// Signal that more data is available
		this._readstream.push(Buffer.from([]));

	}

}

module.exports.APNGMaker = APNGMaker;