import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Seeded random number generator
function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

let camera, scene, renderer, composer;
let gridSize = 5;
let spacing = 5;
let images = new Map();
let mouseDown = false;
let lastMouse = { x: 0, y: 0 };
let velocity = { x: 0, y: 0 };
let dragOffset = { x: 0, y: 0 };
let stars = [];
let textureLoader;
let imageCache = new Map();
let random = mulberry32(42);
let totalImages = 0;
let imagePairs = [];

// Audio variables
let audioContext;
let audioElement;
let audioSource;
let gainNode;
let playbackRate = 1.0;
let targetPlaybackRate = 1.0;
let isAudioInitialized = false;
let isMouseDown = false;
let slowdownTimer = null;
const MIN_PLAYBACK_RATE = 0.1;
const MAX_PLAYBACK_RATE = 1.0;
const SLOWDOWN_SPEED = 0.02; // How fast the audio slows down when holding
const SPEEDUP_SPEED = 0.05; // How fast the audio speeds up when releasing
let isDragging = false;
let dragStartTime = 0;
const DRAG_THRESHOLD = 200; // milliseconds to distinguish between click and drag

// Add velocity-based fisheye shader
const fisheyeShader = {
  uniforms: {
    "tDiffuse": { value: null },
    "distortion": { value: 0.0 },
    "resolution": { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float distortion;
    uniform vec2 resolution;
    varying vec2 vUv;

    void main() {
      vec2 center = vec2(0.5, 0.5);
      vec2 uv = vUv - center;
      float dist = length(uv);
      
      // Apply fisheye distortion based on velocity
      float distortionFactor = 1.0 + distortion * (1.0 - dist * dist);
      uv = uv * distortionFactor;
      
      // Add some chromatic aberration
      vec3 color;
      color.r = texture2D(tDiffuse, uv + center + vec2(distortion * 0.01, 0.0)).r;
      color.g = texture2D(tDiffuse, uv + center).g;
      color.b = texture2D(tDiffuse, uv + center - vec2(distortion * 0.01, 0.0)).b;
      
      gl_FragColor = vec4(color, 1.0);
    }
  `
};

// Function to detect available images
async function detectAvailableImages() {
  let count = 0;
  while (true) {
    try {
      const response = await fetch(`/images/img${count}.jpg`);
      if (response.ok) {
        count++;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return count;
}

// Function to create random pairs from available images
function createImagePairs(totalImages) {
  const pairs = [];
  const availableIndices = Array.from({length: totalImages}, (_, i) => i);
  
  // Shuffle the array
  for (let i = availableIndices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [availableIndices[i], availableIndices[j]] = [availableIndices[j], availableIndices[i]];
  }
  
  // Create pairs
  for (let i = 0; i < availableIndices.length - 1; i += 2) {
    if (i + 1 < availableIndices.length) {
      pairs.push([availableIndices[i], availableIndices[i + 1]]);
    } else {
      // If we have an odd number of images, pair the last one with a random other image
      const randomIndex = Math.floor(random() * (availableIndices.length - 1));
      pairs.push([availableIndices[i], availableIndices[randomIndex]]);
    }
  }
  
  return pairs;
}

// Add raycaster for click detection
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function onImageClick(event) {
  // Don't handle clicks if we're clicking on the overlay or its children
  if (event.target.closest('#image-overlay')) {
    return;
  }

  // Don't handle clicks if we were dragging
  if (isDragging || Date.now() - dragStartTime > DRAG_THRESHOLD) {
    return;
  }

  // Calculate mouse position in normalized device coordinates
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Update the picking ray with the camera and mouse position
  raycaster.setFromCamera(mouse, camera);

  // Calculate objects intersecting the picking ray
  const intersects = raycaster.intersectObjects(Array.from(images.values()));

  if (intersects.length > 0) {
    const clickedMesh = intersects[0].object;
    const imageIndex = clickedMesh.userData.imageIndex;
    
    // Show the expanded image
    const overlay = document.getElementById('image-overlay');
    const expandedImage = document.getElementById('expanded-image');
    expandedImage.src = `/images/img${imageIndex}.jpg`;
    overlay.classList.add('active');

    // Add click handler for the close button
    const closeButton = document.querySelector('.close-button');
    closeButton.onclick = (e) => {
      e.stopPropagation();
      overlay.classList.remove('active');
    };

    // Close on overlay click
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        e.stopPropagation();
        overlay.classList.remove('active');
      }
    };
  }
}

export async function initScene() {
  const container = document.getElementById('canvas-container');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 10;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  // Add starfield
  const starGeometry = new THREE.BufferGeometry();
  const starMaterial = new THREE.PointsMaterial({
    color: 0xFFFFFF,
    size: 0.15,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending
  });

  const starVertices = [];
  const starSizes = [];
  for (let i = 0; i < 2000; i++) {
    const x = (Math.random() - 0.5) * 150;
    const y = (Math.random() - 0.5) * 150;
    const z = (Math.random() - 0.5) * 150;
    starVertices.push(x, y, z);
    starSizes.push(Math.random() * 0.5 + 0.1); // Random size between 0.1 and 0.6
  }

  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starVertices, 3));
  starGeometry.setAttribute('size', new THREE.Float32BufferAttribute(starSizes, 1));
  const starField = new THREE.Points(starGeometry, starMaterial);
  starField.position.z = -50; // Move stars behind everything
  scene.add(starField);
  stars.push(starField);

  // Setup post-processing
  composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.5,  // Increased strength
    0.4,  // radius
    0.85  // threshold
  );
  composer.addPass(bloomPass);

  const bokehPass = new BokehPass(scene, camera, {
    focus: 10.0,
    aperture: 0.00002,
    maxblur: 0.01
  });
  composer.addPass(bokehPass);

  // Add fisheye effect
  const fisheyePass = new ShaderPass(fisheyeShader);
  composer.addPass(fisheyePass);

  // Store passes for animation
  window.fisheyePass = fisheyePass;

  // Detect available images and create pairs
  totalImages = await detectAvailableImages();
  imagePairs = createImagePairs(totalImages);
  
  textureLoader = new THREE.TextureLoader();
  
  // Initialize the grid around the camera
  updateGrid();

  window.addEventListener('resize', onWindowResize);
  window.addEventListener('mousedown', (event) => { 
    mouseDown = true;
    dragOffset.x = 0;
    dragOffset.y = 0;
    lastMouse.x = event.clientX;
    lastMouse.y = event.clientY;
    onMouseDown();
  });
  window.addEventListener('mouseup', () => { 
    mouseDown = false; 
    isDragging = false;
    onMouseUp();
  });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('click', onImageClick);

  // Add touch event handlers
  window.addEventListener('touchstart', (event) => {
    event.preventDefault();
    mouseDown = true;
    dragOffset.x = 0;
    dragOffset.y = 0;
    lastMouse.x = event.touches[0].clientX;
    lastMouse.y = event.touches[0].clientY;
    onMouseDown();
  }, { passive: false });

  window.addEventListener('touchend', (event) => {
    event.preventDefault();
    mouseDown = false;
    isDragging = false;
    onMouseUp();
  }, { passive: false });

  window.addEventListener('touchmove', (event) => {
    event.preventDefault();
    if (!mouseDown) return;
    
    const touch = event.touches[0];
    const deltaX = touch.clientX - lastMouse.x;
    const deltaY = touch.clientY - lastMouse.y;
    
    // If we've moved more than a few pixels, consider it a drag
    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
      isDragging = true;
    }
    
    // Update drag offset
    dragOffset.x += deltaX;
    dragOffset.y += deltaY;
    
    // Apply movement directly to camera position (inverted direction)
    camera.position.x -= deltaX * 0.02;
    camera.position.y += deltaY * 0.02;
    
    // Update velocity based on movement (inverted direction)
    velocity.x = -deltaX * 0.02;
    velocity.y = deltaY * 0.02;
    
    // Update last touch position
    lastMouse.x = touch.clientX;
    lastMouse.y = touch.clientY;
  }, { passive: false });

  animate();
}

function getGridKey(x, y) {
  return `${x},${y}`;
}

function getSurroundingImages(gridX, gridY) {
  const surrounding = [];
  // Check all 8 surrounding cells
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      if (x === 0 && y === 0) continue; // Skip the current cell
      const key = getGridKey(gridX + x, gridY + y);
      if (images.has(key)) {
        surrounding.push(images.get(key).userData.imageIndex);
      }
    }
  }
  return surrounding;
}

function getValidImageIndex(gridX, gridY, surroundingImages) {
  const seed = Math.abs(gridX * 73856093) ^ Math.abs(gridY * 19349663);
  const localRandom = mulberry32(seed);
  
  // Get all available images that aren't in the surrounding cells
  const availableImages = Array.from({length: totalImages}, (_, i) => i)
    .filter(index => !surroundingImages.includes(index));
  
  if (availableImages.length === 0) {
    // If no valid images, use any image that's not directly adjacent
    const nonAdjacentImages = Array.from({length: totalImages}, (_, i) => i)
      .filter(index => {
        const isAdjacent = surroundingImages.some(adjIndex => 
          Math.abs(adjIndex - index) === 1 || // Direct neighbors
          Math.abs(adjIndex - index) === 0    // Same image
        );
        return !isAdjacent;
      });
    
    if (nonAdjacentImages.length > 0) {
      return nonAdjacentImages[Math.floor(localRandom() * nonAdjacentImages.length)];
    }
  }
  
  // If we have valid images, randomly select one
  return availableImages[Math.floor(localRandom() * availableImages.length)];
}

function getImageIndex(gridX, gridY) {
  const surroundingImages = getSurroundingImages(gridX, gridY);
  return getValidImageIndex(gridX, gridY, surroundingImages);
}

function createImageMesh(gridX, gridY) {
  const i = getImageIndex(gridX, gridY);
  const key = getGridKey(gridX, gridY);
  
  if (!imageCache.has(i)) {
    imageCache.set(i, textureLoader.load(`/images/img${i}.jpg`));
  }
  
  const material = new THREE.MeshBasicMaterial({
    map: imageCache.get(i),
    transparent: true,
    opacity: 0.9
  });
  
  const geometry = new THREE.PlaneGeometry(4, 4);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(gridX * spacing, gridY * spacing, 0);
  mesh.userData.imageIndex = i; // Store the image index for reference
  scene.add(mesh);
  images.set(key, mesh);
  return mesh;
}

function updateGrid() {
  const cameraGridX = Math.floor(camera.position.x / spacing);
  const cameraGridY = Math.floor(camera.position.y / spacing);
  const viewDistance = gridSize + 2; // Buffer of 2 extra cells in each direction

  // Remove images that are too far from the camera
  for (const [key, mesh] of images.entries()) {
    const [x, y] = key.split(',').map(Number);
    if (Math.abs(x - cameraGridX) > viewDistance || Math.abs(y - cameraGridY) > viewDistance) {
      scene.remove(mesh);
      images.delete(key);
    }
  }

  // Add new images around the camera
  for (let x = cameraGridX - viewDistance; x <= cameraGridX + viewDistance; x++) {
    for (let y = cameraGridY - viewDistance; y <= cameraGridY + viewDistance; y++) {
      const key = getGridKey(x, y);
      if (!images.has(key)) {
        createImageMesh(x, y);
      }
    }
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  if (window.fisheyePass) {
    window.fisheyePass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
  }
}

function initAudio() {
  if (isAudioInitialized) return;
  
  // Create audio context
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  
  // Create audio element
  audioElement = new Audio('/audio/audio.mp3');
  audioElement.loop = true;
  audioElement.currentTime = 80; // Start at 1:25
  
  // Create audio source and connect nodes
  audioSource = audioContext.createMediaElementSource(audioElement);
  gainNode = audioContext.createGain();
  
  // Connect the nodes
  audioSource.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  // Start playback
  audioElement.play();
  isAudioInitialized = true;
}

function updateAudioEffects() {
  if (!isAudioInitialized) return;
  
  // Smoothly interpolate the playback rate
  if (playbackRate !== targetPlaybackRate) {
    const diff = targetPlaybackRate - playbackRate;
    playbackRate += diff * (isMouseDown ? SLOWDOWN_SPEED : SPEEDUP_SPEED);
    
    // Apply dampening effect
    if (!isMouseDown && playbackRate < MAX_PLAYBACK_RATE) {
      targetPlaybackRate = MAX_PLAYBACK_RATE;
    }
    
    // Apply the playback rate
    audioElement.playbackRate = Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, playbackRate));
  }
}

function onMouseDown() {
  isMouseDown = true;
  isDragging = false;
  dragStartTime = Date.now();
  targetPlaybackRate = MIN_PLAYBACK_RATE;
  
  // Initialize audio on first click if not already initialized
  if (!isAudioInitialized) {
    initAudio();
  }
}

function onMouseUp() {
  isMouseDown = false;
  targetPlaybackRate = MAX_PLAYBACK_RATE;
}

function onMouseMove(event) {
  if (!mouseDown) return;
  
  // Calculate the movement delta
  const deltaX = event.clientX - lastMouse.x;
  const deltaY = event.clientY - lastMouse.y;
  
  // If we've moved more than a few pixels, consider it a drag
  if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
    isDragging = true;
  }
  
  // Update drag offset
  dragOffset.x += deltaX;
  dragOffset.y += deltaY;
  
  // Apply movement directly to camera position (inverted direction)
  camera.position.x -= deltaX * 0.02;
  camera.position.y += deltaY * 0.02;
  
  // Update velocity based on movement (inverted direction)
  velocity.x = -deltaX * 0.02;
  velocity.y = deltaY * 0.02;
  
  // Update last mouse position
  lastMouse.x = event.clientX;
  lastMouse.y = event.clientY;
}

function animate() {
  requestAnimationFrame(animate);

  // Only apply momentum when not dragging
  if (!mouseDown) {
    // Update camera position with momentum
    camera.position.x += velocity.x;
    camera.position.y += velocity.y;
    
    // Dampen velocity
    velocity.x *= 0.95;
    velocity.y *= 0.95;
  }

  // Update audio effects
  updateAudioEffects();

  // Calculate total velocity for distortion
  const totalVelocity = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
  
  // Update fisheye distortion based on velocity
  if (window.fisheyePass) {
    // Smoothly interpolate distortion based on velocity
    const targetDistortion = Math.min(totalVelocity * 2.0, 0.1); // Cap at 0.5
    window.fisheyePass.uniforms.distortion.value += (targetDistortion - window.fisheyePass.uniforms.distortion.value) * 0.1;
  }

  // Update starfield position to follow camera
  stars.forEach(starField => {
    starField.position.x = camera.position.x;
    starField.position.y = camera.position.y;
    starField.rotation.y += 0.0002;
    starField.rotation.x += 0.0001;
  });

  // Update grid based on camera position
  updateGrid();

  camera.lookAt(new THREE.Vector3(camera.position.x, camera.position.y, 0));

  composer.render();
}
