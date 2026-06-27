/**
 * vshlib-qeb - v1.2.0
 * VSH Quick Encapsulation Bridge for Web
 * Biblioteca cliente para o protocolo híbrido VSH (VPN Shell)
 */

export class VSHClient {
    /**
     * Inicializa o cliente VSH para Web
     * @param {string} gatewayUrl - URL do Gateway VSH (ex: wss://servidor:51822)
     * @param {Object} options - Configurações opcionais
     */
    constructor(gatewayUrl, options = {}) {
        this.gatewayUrl = gatewayUrl;
        this.version = 1; // Protocolo VSH v1.2 mapeia a versão major 1
        this.sessionId = options.sessionId || Math.floor(Math.random() * 65535);
        this.packetCounter = 0;
        this.socket = null;
        this.currentSubChannel = 0; // TTY/Terminal ativo no momento
        
        // Handlers de Eventos (Devem ser sobrescritos na sua aplicação)
        this.onConnect = () => {};
        this.onShellData = (data) => {};
        this.onVPNData = (arrayBuffer) => {};
        this.onSystemMessage = (message) => {};
        this.onDisconnect = () => {};
        this.onError = (error) => {};
    }

    /**
     * Inicia a conexão WebSocket com o Gateway VSH
     */
    connect() {
        try {
            this.socket = new WebSocket(this.gatewayUrl);
            this.socket.binaryType = 'arraybuffer';

            this.socket.onopen = () => {
                this.onConnect();
                // Envia pacote de inicialização no canal de controle (0x00)
                const encoder = new TextEncoder();
                this._sendPacket(0x00, encoder.encode("VSH_CONNECT"));
            };

            this.socket.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    this._handleIncomingPacket(event.data);
                } else {
                    console.warn("[VSH] Pacote de texto inesperado recebido do Gateway.");
                }
            };

            this.socket.onerror = (error) => {
                this.onError(error);
            };

            this.socket.onclose = () => {
                this.onDisconnect();
            };
        } catch (err) {
            this.onError(err);
        }
    }

    /**
     * Envia entrada de texto para o Shell. Intercepta comandos internos prefixados com ":"
     * @param {string} input - Comando ou caractere digitado pelo usuário
     */
    sendShellInput(input) {
        // Intercepta se o usuário digitar um comando interno do ecossistema VSH
        if (input.trim().startsWith(':')) {
            this._executeInternalCommand(input.trim());
            return;
        }

        // Se for tráfego comum de terminal, envia via Canal 0x01 (Shell)
        const encoder = new TextEncoder();
        this._sendPacket(0x01, encoder.encode(input));
    }

    /**
     * Envia pacotes de rede brutos encapsulados para a VPN
     * @param {ArrayBuffer|Uint8Array} binaryData - Dados IP brutos da rede virtual
     */
    sendVPNTraffic(binaryData) {
        const payload = binaryData instanceof Uint8Array ? binaryData : new Uint8Array(binaryData);
        this._sendPacket(0x02, payload);
    }

    /**
     * Executa lógica local para comandos nativos do VSH
     * @param {string} cmdLine 
     */
    _executeInternalCommand(cmdLine) {
        const parts = cmdLine.split(' ');
        const command = parts[0];

        switch (command) {
            case ':status':
                this.onSystemMessage(`\r\n[VSH v1.2.0] Ativo | Sessão ID: ${this.sessionId} | Pacotes: ${this.packetCounter} | TTY Atual: #${this.currentSubChannel}\r\n`);
                break;
            case ':routes':
                this.onSystemMessage(`\r\n[VSH VPN] Sub-redes acessíveis através do túnel:\r\n -> 10.0.0.0/24 (Interna)\r\n -> 192.168.50.0/24 (DMZ)\r\n`);
                break;
            case ':new-tty':
                this.currentSubChannel++;
                this.onSystemMessage(`\r\n[VSH] Criando e alternando para Terminal Virtual TTY #${this.currentSubChannel}...\r\n`);
                this._sendPacket(0x00, new TextEncoder().encode(`NEW_TTY_${this.currentSubChannel}`));
                break;
            case ':channels':
                this.onSystemMessage(`\r\n[VSH] Canais Virtuais:\r\n -> 0x00 (Controle) [OK]\r\n -> 0x01 (Shell - TTY #${this.currentSubChannel}) [Ativo]\r\n -> 0x02 (VPN/Túnel IP) [Pronto]\r\n`);
                break;
            case ':disconnect':
                this.onSystemMessage(`\r\n[VSH] Encerrando sessão por comando do usuário...\r\n`);
                this.disconnect();
                break;
            default:
                this.onSystemMessage(`\r\n[VSH Erro] Comando '${command}' não existe no VSH v1.2.0.\r\n`);
        }
    }

    /**
     * Monta o cabeçalho binário padrão do VSH (10 Bytes de Header fixo)
     * Estrutura: Version (1B), Channel (1B), SubChannel (1B), Flags (1B), PacketID (4B), Length (2B)
     */
    _sendPacket(channelId, payload) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

        this.packetCounter++;
        const payloadLength = payload.length;
        
        // Aloca espaço: 10 Bytes do cabeçalho + tamanho do payload
        const buffer = new ArrayBuffer(10 + payloadLength);
        const view = new DataView(buffer);

        // Construindo o Header de acordo com a especificação VSH v1.2
        view.setUint8(0, this.version);            // Byte 0: Versão do protocolo
        view.setUint8(1, channelId);               // Byte 1: ID do Canal (0x00, 0x01, 0x02)
        view.setUint8(2, this.currentSubChannel);  // Byte 2: ID do Sub-canal/TTY
        view.setUint8(3, 0);                       // Byte 3: Reservado para Flags
        view.setUint32(4, this.packetCounter);     // Bytes 4-7: ID do pacote (Contador)
        view.setUint16(8, payloadLength);          // Bytes 8-9: Tamanho do payload

        // Copia os dados do payload para o espaço após o cabeçalho
        const finalArray = new Uint8Array(buffer);
        finalArray.set(payload, 10);

        // Transmite o buffer binário bruto
        this.socket.send(buffer);
    }

    /**
     * Desempacota o cabeçalho recebido e encaminha os dados para o canal correto
     */
    _handleIncomingPacket(arrayBuffer) {
        if (arrayBuffer.byteLength < 10) return; // Pacote corrompido ou menor que o cabeçalho

        const view = new DataView(arrayBuffer);
        
        const version = view.getUint8(0);
        const channelId = view.getUint8(1);
        const subChannel = view.getUint8(2);
        // view.getUint8(3) -> Flags ignoradas temporariamente nesta versão
        const packetId = view.getUint32(4);
        const payloadLength = view.getUint16(8);

        // Garante a integridade do tamanho do buffer recebido
        if (arrayBuffer.byteLength < 10 + payloadLength) return;

        // Extrai o payload fatiando o buffer a partir do byte 10
        const payload = new Uint8Array(arrayBuffer, 10, payloadLength);
        const decoder = new TextDecoder();

        // Roteamento interno por canais
        switch(channelId) {
            case 0x00: // Controle
                const ctrlMsg = decoder.decode(payload);
                if (ctrlMsg.startsWith("ERR_")) {
                    this.onError(`Erro do Servidor VSH: ${ctrlMsg}`);
                } else {
                    this.onSystemMessage(`[Controle VSH]: ${ctrlMsg}\r\n`);
                }
                break;
                
            case 0x01: // Shell / TTY
                // Só processa se o dado for do terminal que o usuário está visualizando
                if (subChannel === this.currentSubChannel) {
                    this.onShellData(decoder.decode(payload));
                }
                break;
                
            case 0x02: // Dados da VPN
                this.onVPNData(payload.buffer);
                break;
                
            default:
                console.warn(`[VSH] Canal desconhecido recebido: ${channelId}`);
        }
    }

    /**
     * Fecha a conexão e encerra o ciclo de vida do cliente
     */
    disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }
}
