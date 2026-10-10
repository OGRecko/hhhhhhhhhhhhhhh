
// ---------------------------------------------------------------------------
// GPU compute capability check (WebGL2 / GLSL)
//
// This runs a short, fixed-size benchmark of a wave-equation compute shader
// to check whether the user's browser/GPU supports the floating-point
// texture operations a GPU-accelerated solver would need, and how fast a
// reference workload runs.
//
// IMPORTANT: this does NOT currently accelerate the app's actual room
// simulation. The real FDTD wave solver (RT60/C50/C80/impulse response)
// runs server-side on the CPU (see server.ts). This benchmark is a
// standalone capability/performance check — do not present its timing as
// if it sped up any specific simulation result, and do not report a
// "cores" figure: GPU core counts aren't reliably queryable from the
// browser, and estimating one from navigator.hardwareConcurrency (a CPU
// thread count) would not be a real number.
// ---------------------------------------------------------------------------

const VS_SOURCE = `#version 300 es
in vec2 position;
out vec2 vUv;
void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FS_SOURCE = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uStatePresent;
uniform sampler2D uStatePast;
uniform float uCourant;
uniform float uDamping;
uniform vec2 uTexelSize;
uniform float uZStride;

void main() {
    // Read present and past pressure
    float pC = texture(uStatePresent, vUv).r;
    float pPast = texture(uStatePast, vUv).r;
    
    // Read 6 immediate neighbors for the 3D Laplacian
    // (Assuming a simplified 2D unwrapping for the benchmark)
    float pL = texture(uStatePresent, vUv - vec2(uTexelSize.x, 0.0)).r;
    float pR = texture(uStatePresent, vUv + vec2(uTexelSize.x, 0.0)).r;
    float pD = texture(uStatePresent, vUv - vec2(0.0, uTexelSize.y)).r;
    float pU = texture(uStatePresent, vUv + vec2(0.0, uTexelSize.y)).r;
    float pB = texture(uStatePresent, vUv - vec2(uZStride, 0.0)).r;
    float pF = texture(uStatePresent, vUv + vec2(uZStride, 0.0)).r;
    
    // The FDTD Wave Equation Core
    float next_p = (2.0 * pC) - pPast + (uCourant * uCourant) * (pL + pR + pU + pD + pF + pB - 6.0 * pC);
    
    // Apply air damping / wall absorption
    next_p *= uDamping;
    
    fragColor = vec4(next_p, 0.0, 0.0, 1.0);
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("GPU Compile Error: Could not create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error("GPU Compile Error: " + info);
    }
    return shader;
}

export async function runGPUBenchmark(elements: number): Promise<{ timeMs: number; supported: boolean }> {
    return new Promise((resolve, reject) => {
        try {
            // 1. Initialize WebGL2 Offscreen Compute Context
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
            
            if (!gl) {
                throw new Error("WebGL2 is not supported by your browser/hardware.");
            }
            
            // Critical extension for floating point textures (required for acoustic pressure)
            const ext = gl.getExtension('EXT_color_buffer_float');
            if (!ext) {
                throw new Error("EXT_color_buffer_float not supported. Cannot run high-precision wave solver.");
            }
            
            // 2. Calculate optimal texture dimensions for N elements
            // Worked example of the sqrt packing, NOT a tier/account limit:
            // 10,000,000 elements would need a ~3163 x 3163 texture. The
            // production public-mode cap is enforced server-side in
            // server/solverWorker.ts; this number is only here to make the
            // texture-sizing arithmetic concrete.
            const texSize = Math.ceil(Math.sqrt(elements));
            const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
            if (texSize > maxTexSize) {
                throw new Error(`GPU Texture limit exceeded. Requested ${texSize}, max is ${maxTexSize}`);
            }
            
            canvas.width = texSize;
            canvas.height = texSize;
            gl.viewport(0, 0, texSize, texSize);
            
            // 3. Compile Shaders
            const vertexShader = createShader(gl, gl.VERTEX_SHADER, VS_SOURCE);
            const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FS_SOURCE);
            const program = gl.createProgram();
            if (!program) throw new Error("Could not create WebGL program");
            
            gl.attachShader(program, vertexShader);
            gl.attachShader(program, fragmentShader);
            gl.linkProgram(program);
            
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                throw new Error("GPU Link Error: " + gl.getProgramInfoLog(program));
            }
            
            // 4. Setup Geometry (Full-screen quad)
            const positionBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
            const positions = new Float32Array([
                -1, -1,  1, -1,  -1, 1,
                -1,  1,  1, -1,   1, 1
            ]);
            gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
            
            const positionLocation = gl.getAttribLocation(program, "position");
            gl.enableVertexAttribArray(positionLocation);
            gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
            
            // 5. Setup Ping-Pong Textures & Framebuffers
            const createTexture = () => {
                const tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, texSize, texSize, 0, gl.RGBA, gl.FLOAT, null);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                return tex;
            };
            
            let texPresent = createTexture();
            let texPast = createTexture();
            let texFuture = createTexture();
            
            const createFramebuffer = (tex: WebGLTexture | null) => {
                const fb = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                return fb;
            };
            
            let fbFuture = createFramebuffer(texFuture);
            
            // 6. Set Uniforms
            gl.useProgram(program);
            
            const locPresent = gl.getUniformLocation(program, "uStatePresent");
            const locPast = gl.getUniformLocation(program, "uStatePast");
            const locCourant = gl.getUniformLocation(program, "uCourant");
            const locDamping = gl.getUniformLocation(program, "uDamping");
            const locTexelSize = gl.getUniformLocation(program, "uTexelSize");
            const locZStride = gl.getUniformLocation(program, "uZStride");
            
            gl.uniform1i(locPresent, 0);
            gl.uniform1i(locPast, 1);
            gl.uniform1f(locCourant, 0.577); // 1/sqrt(3) for 3D stability
            gl.uniform1f(locDamping, 0.999);
            gl.uniform2f(locTexelSize, 1.0 / texSize, 1.0 / texSize);
            
            // Hardcoded benchmark constant, NOT a production limit: this
            // fixed-size synthetic benchmark uses a ~10M-element cube, whose
            // edge length is roughly 215 (215^3 ~= 9.9M), and maps Z slices
            // along the X axis as a simplification. A real simulation would
            // derive this stride from its own grid dimensions rather than
            // this literal. The server's public FDTD ceiling is 50,000,000 cells.
            gl.uniform1f(locZStride, 215.0 / texSize); 
            
            // 7. Execute the GPU Compute Loop
            const numSteps = 10;
            const startTime = performance.now();
            
            for (let i = 0; i < numSteps; i++) {
                // Bind outputs
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbFuture);
                
                // Bind inputs
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, texPresent);
                
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, texPast);
                
                // Execute GPU Compute (Draw full screen quad)
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                
                // Ping-Pong buffers
                const tempTex = texPast;
                texPast = texPresent;
                texPresent = texFuture;
                texFuture = tempTex;
                
                // Update FB output target
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texFuture, 0);
            }
            
            // Force WebGL to finish computing by reading one pixel
            // This is critical, otherwise the JS thread continues before the GPU is done!
            const readData = new Float32Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, readData);
            
            const endTime = performance.now();
            const durationMs = Math.round(endTime - startTime);
            
            // Cleanup memory
            gl.deleteTexture(texPresent);
            gl.deleteTexture(texPast);
            gl.deleteTexture(texFuture);
            gl.deleteFramebuffer(fbFuture);
            gl.deleteProgram(program);
            gl.deleteShader(vertexShader);
            gl.deleteShader(fragmentShader);
            gl.deleteBuffer(positionBuffer);
            
            // Return actual measured time. No fabricated hardware figures —
            // if you need a real core count, query it from the GPU driver
            // via a proper native binding; it isn't obtainable from a
            // browser WebGL2 context.
            resolve({
                timeMs: durationMs,
                supported: true,
            });
            
        } catch (err: any) {
            console.error("GPU Compute Failed:", err);
            reject(err);
        }
    });
}
