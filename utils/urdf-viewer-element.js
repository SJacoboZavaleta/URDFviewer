import * as THREE from 'three';
import { MeshPhongMaterial } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import URDFLoader from './URDFLoader.js';

const tempVec2 = new THREE.Vector2();
const emptyRaycast = () => { };

export default class URDFViewer extends HTMLElement {

    static get observedAttributes() {
        return ['package', 'urdf', 'up', 'display-shadow', 'ambient-color', 'ignore-limits', 'show-collision'];
    }

    constructor() {
        super();
        this._requestId = 0;
        this._dirty = false;
        this._loadScheduled = false;
        this.robot = null;
        this.loadMeshFunc = null;
        this.urlModifierFunc = null;

        this.initScene();
        this.initLights();
        this.initRenderer();
        this.initCamera();
        this.initControls();
        this.initEnvironment();

        this._collisionMaterial = new MeshPhongMaterial({
            transparent: true,
            opacity: 0.35,
            shininess: 2.5,
            premultipliedAlpha: true,
            color: 0xffbe38,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });

        this.startRenderLoop();
    }

    connectedCallback() {
        if (!this.constructor._styletag) {
            const styletag = document.createElement('style');
            styletag.innerHTML = `
                ${this.tagName} { display: block; }
                ${this.tagName} canvas {
                    width: 100%;
                    height: 100%;
                }
            `;
            document.head.appendChild(styletag);
            this.constructor._styletag = styletag;
        }

        if (this.childElementCount === 0) {
            this.appendChild(this.renderer.domElement);
        }

        this.updateSize();
        requestAnimationFrame(() => this.updateSize());
    }

    disconnectedCallback() {
        cancelAnimationFrame(this._renderLoopId);
    }

    attributeChangedCallback(attr, oldval, newval) {
        switch (attr) {
            case 'package':
            case 'urdf':
                this._scheduleLoad();
                break;
            case 'up':
                this._setUp(this.up);
                break;
            case 'ambient-color':
                this.ambientLight.color.set(this.ambientColor);
                this.ambientLight.groundColor.set('#000').lerp(this.ambientLight.color, 0.5);
                break;
            case 'ignore-limits':
                this._setIgnoreLimits(this.ignoreLimits, true);
                break;
        }
        this._updateCollisionVisibility();
        if (!this.noAutoRecenter) this.recenter();
    }

    initScene() {
        this.scene = new THREE.Scene();
        this.world = new THREE.Object3D();
        this.scene.add(this.world);
    }

    initLights() {
        this.ambientLight = new THREE.HemisphereLight(this.ambientColor, '#000');
        this.ambientLight.groundColor.lerp(this.ambientLight.color, 0.5 * Math.PI);
        this.ambientLight.intensity = 0.5;
        this.ambientLight.position.set(0, 1, 0);
        this.scene.add(this.ambientLight);

        this.directionalLight = new THREE.DirectionalLight(0xffffff, Math.PI);
        this.directionalLight.position.set(4, 10, 1);
        this.directionalLight.shadow.mapSize.width = 2048;
        this.directionalLight.shadow.mapSize.height = 2048;
        this.directionalLight.shadow.normalBias = 0.001;
        this.directionalLight.castShadow = true;
        this.scene.add(this.directionalLight);
        this.scene.add(this.directionalLight.target);
    }

    initRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setClearColor(0xffffff);
        this.renderer.setClearAlpha(0);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    initCamera() {
        this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
        this.camera.position.z = 7;
        this.camera.zoom = 8;
    }

    initControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.rotateSpeed = 2.0;
        this.controls.zoomSpeed = 5;
        this.controls.panSpeed = 2;
        this.controls.enableZoom = true;
        this.controls.enableDamping = false;
        this.controls.maxDistance = 50;
        this.controls.minDistance = 0.25;
        this.controls.addEventListener('change', () => this.recenter());
    }

    initEnvironment() {
        this.plane = new THREE.Mesh(
            new THREE.PlaneGeometry(40, 40),
            new THREE.ShadowMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.25 }),
        );
        this.plane.rotation.x = -Math.PI / 2;
        this.plane.position.y = -0.5;
        this.plane.receiveShadow = true;
        this.plane.scale.set(10, 10, 10);
        this.scene.add(this.plane);
    }

    startRenderLoop() {
        const renderLoop = () => {
            if (this.parentNode) {
                this.updateSize();
                if (this._dirty || this.autoRedraw) {
                    if (!this.noAutoRecenter) {
                        this._updateEnvironment();
                    }
                    this.renderer.render(this.scene, this.camera);
                    this._dirty = false;
                }
                this.controls.update();
            }
            this._renderLoopId = requestAnimationFrame(renderLoop);
        };
        renderLoop();
    }

    updateSize() {
        const r = this.renderer;
        const w = this.clientWidth;
        const h = this.clientHeight;
        const currSize = r.getSize(tempVec2);

        if (currSize.width !== w || currSize.height !== h) {
            this.recenter();
        }

        r.setPixelRatio(window.devicePixelRatio);
        r.setSize(w, h, false);

        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    recenter() {
        this._updateEnvironment();
        this.redraw();
    }

    setJointValue(jointName, ...values) {
        if (!this.robot) return;
        if (!this.robot.joints[jointName]) return;

        if (this.robot.joints[jointName].setJointValue(...values)) {
            this.redraw();
            this.dispatchEvent(new CustomEvent('angle-change', { bubbles: true, cancelable: true, detail: jointName }));
        }
    }

    setJointValues(values) {
        for (const name in values) this.setJointValue(name, values[name]);
    }

    redraw() {
        this._dirty = true;
    }

    _updateEnvironment() {
        const robot = this.robot;
        if (!robot) return;

        this.world.updateMatrixWorld();

        const bbox = new THREE.Box3();
        bbox.makeEmpty();
        robot.traverse(c => {
            if (c.isURDFVisual) {
                bbox.expandByObject(c);
            }
        });

        const center = bbox.getCenter(new THREE.Vector3());
        this.controls.target.y = center.y;
        this.plane.position.y = bbox.min.y - 1e-3;

        const dirLight = this.directionalLight;
        dirLight.castShadow = this.displayShadow;

        if (this.displayShadow) {
            const sphere = bbox.getBoundingSphere(new THREE.Sphere());
            const minmax = sphere.radius;
            const cam = dirLight.shadow.camera;
            cam.left = cam.bottom = -minmax;
            cam.right = cam.top = minmax;

            const offset = dirLight.position.clone().sub(dirLight.target.position);
            dirLight.target.position.copy(center);
            dirLight.position.copy(center).add(offset);

            cam.updateProjectionMatrix();
        }
    }

    _scheduleLoad() {
        if (this._prevload === `${this.package}|${this.urdf}`) return;
        this._prevload = `${this.package}|${this.urdf}`;

        if (this._loadScheduled) return;
        this._loadScheduled = true;

        if (this.robot) {
            this.robot.traverse(c => c.dispose && c.dispose());
            this.robot.parent.remove(this.robot);
            this.robot = null;
        }

        requestAnimationFrame(() => {
            this._loadUrdf(this.package, this.urdf);
            this._loadScheduled = false;
        });
    }

    async _loadUrdf(pkg, urdf) {
        this.dispatchEvent(new CustomEvent('urdf-change', { bubbles: true, cancelable: true, composed: true }));

        if (urdf) {
            this._requestId++;
            const requestId = this._requestId;

            const updateMaterials = mesh => {
                mesh.traverse(c => {
                    if (c.isMesh) {
                        c.castShadow = true;
                        c.receiveShadow = true;

                        const materialName = c.userData.material;
                        const material = urdf.materials[materialName];
                        if (material) {
                            c.material = material;
                        } else {
                            console.warn(`Material ${materialName} not found`);
                            c.material = new THREE.MeshPhongMaterial();
                        }
                    }
                });
            };

            // Handle package parsing
            if (pkg.includes(':') && (pkg.split(':')[1].substring(0, 2)) !== '//') {
                pkg = pkg.split(',').reduce((map, value) => {
                    const split = value.split(/:/).filter(x => !!x);
                    const pkgName = split.shift().trim();
                    const pkgPath = split.join(':').trim();
                    map[pkgName] = pkgPath;
                    return map;
                }, {});
            }

            let robot = null;
            const manager = new THREE.LoadingManager();
            manager.onLoad = () => {
                if (this._requestId !== requestId) {
                    robot.traverse(c => c.dispose && c.dispose());
                    return;
                }

                this.robot = robot;
                this.world.add(robot);
                updateMaterials(robot);

                this._setIgnoreLimits(this.ignoreLimits);
                this._updateCollisionVisibility();

                this.dispatchEvent(new CustomEvent('urdf-processed', { bubbles: true, cancelable: true, composed: true }));
                this.dispatchEvent(new CustomEvent('geometry-loaded', { bubbles: true, cancelable: true, composed: true }));

                this.recenter();
            };

            if (this.urlModifierFunc) {
                manager.setURLModifier(this.urlModifierFunc);
            }

            const loader = new URDFLoader(manager);
            loader.packages = pkg;
            loader.loadMeshCb = this.loadMeshFunc;
            loader.fetchOptions = { mode: 'cors', credentials: 'same-origin' };
            loader.parseCollision = true;
            loader.load(urdf, model => {
                robot = model;
                updateMaterials(robot);
                this.robot = robot;
                this.world.add(robot);
                this._setIgnoreLimits(this.ignoreLimits);
                this._updateCollisionVisibility();
                this.dispatchEvent(new CustomEvent('urdf-processed', { bubbles: true, cancelable: true, composed: true }));
                this.dispatchEvent(new CustomEvent('geometry-loaded', { bubbles: true, cancelable: true, composed: true }));
                this.recenter();
            });
        }
    }

    _setRobot(robot) {
        if (this.robot) {
            this.world.remove(this.robot);
            this.robot.traverse(c => {
                if (c.geometry) c.geometry.dispose();
                if (c.material) c.material.dispose();
            });
        }

        this.robot = robot;
        if (robot) {
            this.world.add(robot);
            this._setUp(this.up);
            this._setIgnoreLimits(this.ignoreLimits);
            this._updateCollisionVisibility();
            if (!this.noAutoRecenter) this.recenter();
        }
    }

    _setUp(up) {

        if (!up) up = '+Z';
        up = up.toUpperCase();
        const sign = up.replace(/[^-+]/g, '')[0] || '+';
        const axis = up.replace(/[^XYZ]/gi, '')[0] || 'Z';

        const PI = Math.PI;
        const HALFPI = PI / 2;
        if (axis === 'X') this.world.rotation.set(0, 0, sign === '+' ? HALFPI : -HALFPI);
        if (axis === 'Z') this.world.rotation.set(sign === '+' ? -HALFPI : HALFPI, 0, 0);
        if (axis === 'Y') this.world.rotation.set(sign === '+' ? 0 : PI, 0, 0);

    }

    _setIgnoreLimits(ignore, noRecenter) {
        if (!this.robot) return;

        this.robot.traverse(c => {
            if (c.isURDFJoint) {
                c.ignoreLimits = ignore;
                c.setJointValue(c.jointValue);
            }
        });

        if (!noRecenter) this.recenter();
    }

    _updateCollisionVisibility() {
        const showCollision = this.showCollision;
        const collisionMaterial = this._collisionMaterial;
        const robot = this.robot;

        if (robot === null) return;

        const colliders = [];
        robot.traverse(c => {
            if (c.isURDFCollider) {
                c.visible = showCollision;
                colliders.push(c);
            }
        });

        colliders.forEach(coll => {
            coll.traverse(c => {
                if (c.isMesh) {
                    c.raycast = emptyRaycast;
                    c.material = collisionMaterial;
                    c.castShadow = false;
                }
            });
        });
    }

    get package() {
        return this.getAttribute('package') || '';
    }

    set package(val) {
        this.setAttribute('package', val);
    }

    get urdf() {
        return this.getAttribute('urdf') || '';
    }

    set urdf(val) {
        this.setAttribute('urdf', val);
    }

    get up() {
        return this.getAttribute('up') || 'z';
    }

    set up(val) {
        this.setAttribute('up', val);
    }

    get displayShadow() {
        return this.hasAttribute('display-shadow');
    }

    set displayShadow(val) {
        if (val) this.setAttribute('display-shadow', '');
        else this.removeAttribute('display-shadow');
    }

    get ambientColor() {
        return this.getAttribute('ambient-color') || '#7d7c7a';
    }

    set ambientColor(val) {
        this.setAttribute('ambient-color', val);
    }

    get ignoreLimits() {
        return this.hasAttribute('ignore-limits');
    }

    set ignoreLimits(val) {
        if (val) this.setAttribute('ignore-limits', '');
        else this.removeAttribute('ignore-limits');
    }

    get showCollision() {
        return this.hasAttribute('show-collision');
    }

    set showCollision(val) {
        if (val) this.setAttribute('show-collision', '');
        else this.removeAttribute('show-collision');
    }
}
