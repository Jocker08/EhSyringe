import { UiTranslation } from 'services/ui-translation';
import { Service } from 'services';
import { ConfigData } from 'services/storage';
import { SyncStorage } from 'services/sync-storage';
import { Logger } from 'services/logger';
import { Messaging } from 'services/messaging';
import { Tagging } from 'services/tagging';
import { DateTime } from 'services/date-time';

import './index.less';

function isNode<K extends keyof HTMLElementTagNameMap>(node: Node, nodeName: K): node is HTMLElementTagNameMap[K] {
    return node && node.nodeName === nodeName.toUpperCase();
}

function isText(node: Node): node is Text {
    return node.nodeType === Node.TEXT_NODE;
}

class TagNodeRef {
    private static readonly ATTR = 'ehs-tag';

    static create(node: Text, service: Syringe): TagNodeRef | boolean {
        const parentElement = node.parentElement;
        if (!parentElement || parentElement.hasAttribute(this.ATTR)) {
            return true;
        }
        const aId = parentElement.id;
        const aTitle = parentElement.title;

        let fullKeyCandidate: string | undefined;
        if (aTitle) {
            const [namespace, key] = aTitle.split(':');
            fullKeyCandidate = service.tagging.fullKey({ namespace, key });
        } else if (aId) {
            let id = aId;
            if (id.startsWith('ta_')) id = id.slice(3);
            const [namespace, key] = id.replace(/_/gi, ' ').split(':');
            fullKeyCandidate = key
                ? service.tagging.fullKey({ namespace, key })
                : service.tagging.fullKey({ namespace: '', key: namespace });
        }

        if (!fullKeyCandidate) return false;
        const fullKey = fullKeyCandidate;
        const text = node.textContent ?? '';

        return new TagNodeRef(parentElement, fullKey, text, service);
    }
    private constructor(
        readonly parent: HTMLElement,
        readonly fullKey: string,
        readonly original: string,
        readonly service: Syringe,
    ) {
        parent.setAttribute(TagNodeRef.ATTR, this.original);
        parent.setAttribute('lang', 'en');
        if (!parent.hasAttribute('title')) {
            parent.title = this.fullKey;
        }
    }

    get alive(): boolean {
        return !!this.parent.parentElement;
    }

    translate(): boolean {
        if (!this.alive) return true;
        if (!this.service.config.translateTag) {
            this.parent.innerText = this.original;
            this.parent.setAttribute('lang', 'en');
            return true;
        }
        if (!this.service.tagMap) {
            return false;
        }
        let value = this.service.tagMap[this.fullKey];
        if (!value) {
            return false;
        }
        if (this.service.config.showIcon) {
            value = this.service.tagging.markImagesAndEmoji(value);
        } else {
            value = this.service.tagging.removeImagesAndEmoji(value);
        }
        if (this.original[1] === ':') {
            value = `${this.original[0]}:${value}`;
        }
        this.parent.innerHTML = value;
        this.parent.setAttribute('lang', 'cmn-Hans');
        return true;
    }
}

@Service()
export class Syringe {
    constructor(
        readonly storage: SyncStorage,
        readonly uiTranslation: UiTranslation,
        readonly logger: Logger,
        readonly messaging: Messaging,
        readonly tagging: Tagging,
        readonly time: DateTime,
    ) {
        storage.async.on('config', (k, ov, nv) => {
            if (nv) this.updateConfig(nv);
        });
        this.init();
    }

    tagMap = this.storage.get('databaseMap');
    private tags: TagNodeRef[] = [];
    private translateTags(): void {
        const tags = (this.tags = this.tags.filter((t) => t.alive));
        tags.forEach((t) => t.translate());
    }
    documentEnd = false;
    readonly skipNode: Set<string> = new Set(['TITLE', 'LINK', 'META', 'HEAD', 'SCRIPT', 'BR', 'HR', 'STYLE', 'MARK']);
    config = this.getAndInitConfig();
    observer?: MutationObserver;

    readonly uiData = this.uiTranslation.get();

    private updateConfig(config: ConfigData): void {
        this.config = config;
        this.storage.set('config', config);
        const body = document.querySelector('body');
        if (body) this.setBodyAttrs(body);
        if (this.tagMap) this.translateTags();
    }

    private getAndInitConfig(): ConfigData {
        this.storage.async
            .get('config')
            .then((conf) => {
                this.updateConfig(conf);
            })
            .catch(this.logger.error);
        return this.storage.get('config');
    }

    private init(): void {
        window.document.addEventListener('DOMContentLoaded', () => {
            this.documentEnd = true;
        });
        const body = document.querySelector('body');
        if (body) {
            const nodes = new Array<Node>();
            this.setBodyAttrs(body);
            const nodeIterator = document.createNodeIterator(body);
            let node = nodeIterator.nextNode();
            while (node) {
                nodes.push(node);
                this.translateNode(node);
                node = nodeIterator.nextNode();
            }
            this.logger.debug(`有 ${nodes.length} 个节点在注入前加载`, nodes);
        } else {
            this.logger.debug(`没有节点在注入前加载`);
        }
        this.observer = new MutationObserver((mutations) =>
            mutations.forEach((mutation) =>
                mutation.addedNodes.forEach((node1) => {
                    this.translateNode(node1);
                    if (this.documentEnd && node1.childNodes) {
                        const nodeIterator = document.createNodeIterator(node1);
                        let node = nodeIterator.nextNode();
                        while (node) {
                            this.translateNode(node);
                            node = nodeIterator.nextNode();
                        }
                    }
                }),
            ),
        );
        this.observer.observe(window.document, {
            attributes: true,
            childList: true,
            subtree: true,
        });

        const timer = this.logger.time('获取替换数据');
        Promise.resolve()
            .then(async () => {
                const currentSha = this.storage.get('databaseSha');
                const data = await this.messaging.emit('get-tag-map', { ifNotMatch: currentSha });
                if (data.map) {
                    const tagMap: this['tagMap'] = {};
                    for (const key in data.map) {
                        tagMap[key] = data.map[key].name;
                    }
                    this.tagMap = tagMap;
                    this.translateTags();
                    this.storage.set('databaseMap', tagMap);
                    this.storage.set('databaseSha', data.sha);
                    this.logger.log('替换数据已更新', data.sha);
                }
                timer.end();
            })
            .catch(this.logger.error);
    }

    setBodyAttrs(node: HTMLBodyElement): void {
        if (!node) return;
        node.classList.add(!location.host.includes('exhentai') ? 'eh' : 'ex');

        node.classList.remove(...[...node.classList.values()].filter((k) => k.startsWith('ehs')));
        if (!this.config.showIcon) {
            node.classList.add('ehs-hide-icon');
        }
        if (this.config.translateTag) {
            node.classList.add('ehs-translate-tag');
        }
        if (this.config.translateUi) {
            node.setAttribute('lang', 'cmn-Hans');
        } else {
            node.setAttribute('lang', 'en');
        }
        node.classList.add(`ehs-image-level-${this.config.introduceImageLevel}`);
    }

    translateNode(node: Node): void {
        if (
            !node.nodeName ||
            this.skipNode.has(node.nodeName) ||
            (node.parentNode && this.skipNode.has(node.parentNode.nodeName))
        ) {
            return;
        }

        if (isNode(node, 'body')) {
            this.setBodyAttrs(node);
        }

        const handled = this.translateTag(node);
        /* tag 处理过的ui不再处理*/
        if (!handled && this.config.translateUi) {
            this.translateUi(node);
        }
    }

    private isTagContainer(node: Element | null): boolean {
        if (!node) {
            return false;
        }
        return node.classList.contains('gt') || node.classList.contains('gtl') || node.classList.contains('gtw');
    }

    translateTag(node: Node): boolean {
        const parentElement = node.parentElement;
        if (!isText(node) || !parentElement) {
            return false;
        }
        if (parentElement.nodeName === 'MARK' || parentElement.classList.contains('auto-complete-text')) {
            // 不翻译搜索提示的内容
            return true;
        }

        // 标签只翻译已知的位置
        if (!this.isTagContainer(parentElement) && !this.isTagContainer(parentElement?.parentElement)) {
            return false;
        }

        const ref = TagNodeRef.create(node, this);

        if (typeof ref == 'boolean') return ref;

        ref.translate();
        this.tags.push(ref);
        return true;
    }

    private translateUiText(text: string): string | undefined {
        const plain = this.uiData.plainReplacements.get(text);
        if (plain != null) return plain;

        let repText = text;
        for (const [k, v] of this.uiData.regexReplacements) {
            repText = repText.replace(k, v as any);
        }

        repText = repText.replace(/\d\d\d\d-\d\d-\d\d \d\d:\d\d/g, (t) => {
            const date = Date.parse(t + 'Z');
            if (!date) return t;
            return `${this.time.diff(date, undefined, DateTime.hour)}`;
        });
        repText = repText.replace(/\d\d \w{2,10} \d\d\d\d, \d\d:\d\d/gi, (t) => {
            const date = Date.parse(t + ' UTC');
            if (!date) return t;
            return `${this.time.diff(date, undefined, DateTime.hour)}`;
        });
        if (repText !== text) return repText;

        return undefined;
    }

    translateUi(node: Node): void {
        if (isText(node)) {
            const text = node.textContent ?? '';
            const translation = this.translateUiText(text);
            if (translation != null) {
                node.textContent = translation;
            }
            return;
        } else if (isNode(node, 'input') || isNode(node, 'textarea')) {
            if (node.placeholder) {
                const translation = this.translateUiText(node.placeholder);
                if (translation != null) {
                    node.placeholder = translation;
                }
            }
            if (node.type === 'submit' || node.type === 'button') {
                const translation = this.translateUiText(node.value);
                if (translation != null) {
                    node.value = translation;
                }
            }
            return;
        } else if (isNode(node, 'optgroup')) {
            const translation = this.translateUiText(node.label);
            if (translation != null) {
                node.label = translation;
            }
            return;
        }

        if (isNode(node, 'a') && node?.parentElement?.parentElement?.id === 'nb') {
            const translation = this.translateUiText(node.textContent ?? '');
            if (translation != null) {
                node.textContent = translation;
            }
        }

        if (isNode(node, 'p') && node.classList.contains('gpc')) {
            /* 兼容熊猫书签，单独处理页码，保留原页码Element，防止熊猫书签取不到报错*/
            const text = node.textContent ?? '';
            const p = document.createElement('p');
            p.textContent = text.replace(/Showing ([\d,]+) - ([\d,]+) of ([\d,]+) images?/, '$1 - $2，共 $3 张图片');
            p.className = 'gpc-translate';
            node.parentElement?.insertBefore(p, node);
            node.style.display = 'none';
        }

        if (isNode(node, 'div')) {
            /* E-Hentai-Downloader 兼容处理 */
            if (node.id === 'gdd') {
                const div = document.createElement('div');
                div.textContent = node.textContent;
                div.style.display = 'none';
                node.insertBefore(div, null);
            }

            /* 熊猫书签 兼容处理 2 */
            if (
                node.parentElement?.id === 'gdo4' &&
                node.classList.contains('ths') &&
                node.classList.contains('nosel')
            ) {
                const div = document.createElement('div');
                div.textContent = node.textContent;
                div.style.display = 'none';
                div.className = 'ths';
                node.parentElement.insertBefore(div, node);
            }
        }
    }
}
