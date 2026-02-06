// purrrr Application JavaScript

// Global variables
let currentSessionId = null;
let currentLogType = null;
let analysisData = {};
let currentFilters = {};

// Column visibility configuration
const AVAILABLE_COLUMNS = [
    { key: 'timestamp', label: 'Date/Heure', visible: true, width: '20%' },
    { key: 'operation', label: 'Opération', visible: true, width: '15%' },
    { key: 'subject', label: 'Détails', visible: true, width: '25%' },
    { key: 'user', label: 'Utilisateur', visible: true, width: '20%' },
    { key: 'Workload', label: 'Workload', visible: false, width: '10%' },
    { key: 'folder', label: 'Dossier', visible: false, width: '15%' }
];

// DOM Elements
const uploadForm = document.getElementById('upload-form');
const uploadSection = document.getElementById('upload-section');
const dashboardSection = document.getElementById('dashboard-section');
const csvFileInput = document.getElementById('csv-file');
const submitBtn = document.getElementById('submit-btn');
const resetBtn = document.getElementById('reset-btn');
const navbarStatus = document.getElementById('navbar-status');

// Initialize
document.addEventListener('DOMContentLoaded', function () {
    setupEventListeners();
    initializeColumnSelectors();
});

function setupEventListeners() {
    uploadForm.addEventListener('submit', handleFileUpload);
    resetBtn.addEventListener('click', resetAnalysis);
    
    // File input listeners
    csvFileInput.addEventListener('change', function () {
        updateFileInputStatus('csv-check', this.value);
    });

    // Items per page selector
    const itemsPerPageSelector = document.getElementById('items-per-page');
    if (itemsPerPageSelector) {
        itemsPerPageSelector.addEventListener('change', function () {
            // Re-initialize pagination with new items per page value
            if (window.timelineCurrentOperations && window.timelineCurrentOperations.length > 0) {
                initializeTimelinePagination(window.timelineCurrentOperations);
            }
        });
    }

    // Plus d'onglets - supprimé les tab listeners
    
    // Filter buttons
    const applyFiltersBtn = document.getElementById('apply-filters');
    const resetFiltersBtn = document.getElementById('reset-filters');
    
    if (applyFiltersBtn) {
        applyFiltersBtn.addEventListener('click', applyFilters);
    }
    if (resetFiltersBtn) {
        resetFiltersBtn.addEventListener('click', resetFilters);
    }
    
    // Add file form
    const addFileForm = document.getElementById('add-file-form');
    const addFileSubmitBtn = document.getElementById('add-file-submit-btn');
    if (addFileForm && addFileSubmitBtn) {
        addFileForm.addEventListener('submit', (e) => {
            e.preventDefault();
            handleAddFile();
        });
        addFileSubmitBtn.addEventListener('click', handleAddFile);
    }
}

function initializeColumnSelectors() {
    const columnsCheckboxes = document.getElementById('columns-checkboxes');
    if (!columnsCheckboxes) return;
    
    columnsCheckboxes.innerHTML = '';
    AVAILABLE_COLUMNS.forEach(col => {
        const checkbox = document.createElement('div');
        checkbox.className = 'form-check';
        checkbox.innerHTML = `
            <input class="form-check-input column-checkbox" type="checkbox" id="col-${col.key}" value="${col.key}" ${col.visible ? 'checked' : ''}>
            <label class="form-check-label" for="col-${col.key}">
                ${col.label}
            </label>
        `;
        columnsCheckboxes.appendChild(checkbox);
        
        // Add change event listener
        checkbox.querySelector('input').addEventListener('change', (e) => {
            const colKey = e.target.value;
            const colIndex = AVAILABLE_COLUMNS.findIndex(c => c.key === colKey);
            if (colIndex !== -1) {
                AVAILABLE_COLUMNS[colIndex].visible = e.target.checked;
            }
            
            // Re-render the table header and rows
            renderTableHeader();
            if (window.timelineCurrentOperations && window.timelineCurrentOperations.length > 0) {
                updateTimelinePage(window.timelineCurrentPage || 1);
            }
        });
    });
}

function renderTableHeader() {
    const headerRow = document.getElementById('timeline-header');
    if (!headerRow) return;
    
    headerRow.innerHTML = '';
    const visibleCols = AVAILABLE_COLUMNS.filter(col => col.visible);
    
    visibleCols.forEach((col, index) => {
        const th = document.createElement('th');
        th.style.width = col.width;
        th.textContent = col.label;
        headerRow.appendChild(th);
    });
}

function getColumnValue(op, colKey) {
    switch(colKey) {
        case 'timestamp':
            return op.timestamp ? new Date(op.timestamp).toLocaleString('fr-FR') : '-';
        case 'operation':
            return `<span class="badge bg-info">${op.operation || '-'}</span>`;
        case 'subject':
            return `<small title="${op.subject || ''}">${op.subject || op.folder || '-'}</small>`;
        case 'user':
            return `<small class="text-muted">${op.user || '-'}</small>`;
        case 'Workload':
            return `<small>${op.Workload || '-'}</small>`;
        case 'folder':
            return `<small class="text-muted" title="${op.folder || ''}">${op.folder || '-'}</small>`;
        default:
            return '-';
    }
}

function getFiltersFromUI() {
    // Get multi-select values as arrays
    const userValues = Array.from(document.getElementById('filter-user')?.selectedOptions || []).map(opt => opt.value).filter(v => v);
    const actionValues = Array.from(document.getElementById('filter-actions')?.selectedOptions || []).map(opt => opt.value).filter(v => v);
    
    return {
        user: userValues,
        actions: actionValues,
        files: document.getElementById('filter-files')?.value || '',
        ips: document.getElementById('filter-ips')?.value || '',
        exclude_ips: document.getElementById('exclude-ips')?.value || '',
        start_date: document.getElementById('filter-date-start')?.value || '',
        end_date: document.getElementById('filter-date-end')?.value || '',
        sort_by: document.getElementById('filter-sort-by')?.value || 'date'
    };
}

function matchesIpPattern(ip, pattern) {
    // Trim whitespace
    ip = ip.trim();
    pattern = pattern.trim();
    
    // If no wildcard, do exact match (case-insensitive for IPs)
    if (!pattern.includes('*')) {
        return ip === pattern;
    }
    
    // Convert wildcard pattern to regex
    // First escape special regex chars, but keep track of * positions
    const regexPattern = pattern
        .split('')
        .map(char => {
            // Keep * as is for now, will be replaced later
            if (char === '*') return '\u0000';  // Temporary placeholder
            // Escape all special regex chars
            if (/[.+?^${}()|[\]\\]/.test(char)) {
                return '\\' + char;
            }
            return char;
        })
        .join('')
        .replace(/\u0000/g, '.*');  // Replace placeholder with .*
    
    try {
        const regex = new RegExp('^' + regexPattern + '$');
        return regex.test(ip);
    } catch (e) {
        // If regex fails, fallback to exact match
        return ip === pattern;
    }
}

function filterIpsList(clientIp, ipFilterString) {
    // If no filter, allow all
    if (!ipFilterString || ipFilterString.trim() === '') {
        return true;
    }
    
    // Split by comma and trim each IP pattern
    const patterns = ipFilterString.split(',').map(p => p.trim()).filter(p => p.length > 0);
    
    // Check if the IP matches any of the patterns
    return patterns.some(pattern => matchesIpPattern(clientIp, pattern));
}

function applyFilters() {
    // Apply timeline filters with the selected values
    // Get multi-select values as arrays (Select2 compatible)
    const filterWorkloadValues = Array.from(document.getElementById('filter-workload')?.selectedOptions || []).map(opt => opt.value).filter(v => v);
    const filterUserValues = Array.from(document.getElementById('filter-user')?.selectedOptions || []).map(opt => opt.value).filter(v => v);
    const filterActionsValues = Array.from(document.getElementById('filter-actions')?.selectedOptions || []).map(opt => opt.value).filter(v => v);
    
    const filterFiles = document.getElementById('filter-files')?.value || '';
    const filterIps = document.getElementById('filter-ips')?.value || '';
    const excludeIps = document.getElementById('exclude-ips')?.value || '';
    const filterDateStart = document.getElementById('filter-date-start')?.value || '';
    const filterDateEnd = document.getElementById('filter-date-end')?.value || '';
    
    // Get the original operations (before any filtering)
    const originalOps = window.timelineOriginalOperations || window.timelineAllOperations || [];
    if (!originalOps || originalOps.length === 0) return;
    
    let filtered = originalOps.filter(op => {
        // Filtre workload - match any selected value
        if (filterWorkloadValues.length > 0 && !filterWorkloadValues.some(val => op.Workload?.toLowerCase() === val.toLowerCase())) {
            return false;
        }
        
        // Filtre utilisateur - match any selected value
        if (filterUserValues.length > 0 && !filterUserValues.some(val => op.user?.toLowerCase() === val.toLowerCase())) {
            return false;
        }
        
        // Filtre opération - match any selected value
        if (filterActionsValues.length > 0 && !filterActionsValues.some(val => op.operation?.toLowerCase() === val.toLowerCase())) {
            return false;
        }
        
        // Filtre fichiers
        if (filterFiles && !op.subject?.toLowerCase().includes(filterFiles.toLowerCase()) && 
                          !op.folder?.toLowerCase().includes(filterFiles.toLowerCase())) {
            return false;
        }
        
        // Filtre IP à inclure - support multiple IPs and wildcards
        if (filterIps) {
            const clientIp = op.ClientIP || op.client_ip || op.ClientIPAddress || op.SenderIp || '';
            if (!filterIpsList(clientIp, filterIps)) {
                return false;
            }
        }
        
        // Filtre IP à exclure - support multiple IPs and wildcards
        if (excludeIps) {
            const clientIp = op.ClientIP || op.client_ip || op.ClientIPAddress || op.SenderIp || '';
            if (filterIpsList(clientIp, excludeIps)) {
                return false;
            }
        }
        
        // Filtre date de début
        if (filterDateStart) {
            const opDate = op.timestamp ? new Date(op.timestamp) : null;
            const startDate = new Date(filterDateStart);
            if (!opDate || opDate < startDate) {
                return false;
            }
        }
        
        // Filtre date de fin
        if (filterDateEnd) {
            const opDate = op.timestamp ? new Date(op.timestamp) : null;
            const endDate = new Date(filterDateEnd);
            // Set end date to end of day (23:59:59)
            endDate.setHours(23, 59, 59, 999);
            if (!opDate || opDate > endDate) {
                return false;
            }
        }
        
        return true;
    });
    
    // Sort by timestamp (descending - most recent first)
    filtered.sort((a, b) => {
        const dateA = a.timestamp ? new Date(a.timestamp) : new Date(0);
        const dateB = b.timestamp ? new Date(b.timestamp) : new Date(0);
        return dateB - dateA;
    });
    
    // Update the global operations to the filtered set
    window.timelineAllOperations = filtered;
    
    // Update badge with filtered count
    const badge = document.getElementById('badge-timeline');
    if (badge) {
        badge.textContent = filtered.length.toLocaleString();
    }
    
    // Analyze patterns in filtered data
    analyzePatterns(filtered);
    
    // Re-initialize pagination with filtered data
    initializeTimelinePagination(filtered);
}

function resetFilters() {
    // Reset multi-select dropdowns
    document.getElementById('filter-workload').value = null;
    $('#filter-workload').val(null).trigger('change');
    
    document.getElementById('filter-user').value = null;
    $('#filter-user').val(null).trigger('change');
    
    document.getElementById('filter-actions').value = null;
    $('#filter-actions').val(null).trigger('change');
    
    // Reset other filters
    document.getElementById('filter-files').value = '';
    document.getElementById('filter-ips').value = '';
    document.getElementById('exclude-ips').value = '';
    document.getElementById('filter-date-start').value = '';
    document.getElementById('filter-date-end').value = '';
    const sortDropdown = document.getElementById('filter-sort-by');
    if (sortDropdown) {
        sortDropdown.value = 'date';
    }
    currentFilters = {};
    
    // Reset pagination to show all original data
    if (window.timelineOriginalOperations) {
        window.timelineAllOperations = window.timelineOriginalOperations;
        
        // Update badge with total count
        const badge = document.getElementById('badge-timeline');
        if (badge) {
            badge.textContent = window.timelineOriginalOperations.length.toLocaleString();
        }
        
        // Analyze patterns in original data
        analyzePatterns(window.timelineOriginalOperations);
        
        initializeTimelinePagination(window.timelineOriginalOperations);
    }
}

function updateFileInputStatus(elementId, value) {
    const element = document.getElementById(elementId);
    if (value) {
        element.style.display = 'inline';
    } else {
        element.style.display = 'none';
    }
}

function populateFilterDropdowns(operations) {
    // Extract unique users, operations, and workloads from the operations data
    // Deduplicate users case-insensitively
    const userMap = new Map(); // Map with lowercase key -> original value
    const uniqueOperations = new Set();
    const uniqueWorkloads = new Set();
    
    operations.forEach(op => {
        if (op.user) {
            const lowerUser = op.user.toLowerCase();
            if (!userMap.has(lowerUser)) {
                userMap.set(lowerUser, op.user);
            }
        }
        if (op.operation) uniqueOperations.add(op.operation);
        if (op.Workload) uniqueWorkloads.add(op.Workload);
    });
    
    // Sort and populate workload dropdown
    const workloadSelect = document.getElementById('filter-workload');
    if (workloadSelect) {
        const currentValue = workloadSelect.value;
        workloadSelect.innerHTML = '<option value="">Toutes les workloads</option>';
        Array.from(uniqueWorkloads).sort().forEach(workload => {
            const option = document.createElement('option');
            option.value = workload;
            option.textContent = workload;
            workloadSelect.appendChild(option);
        });
        workloadSelect.value = currentValue;
    }
    
    // Sort and populate user dropdown
    const userSelect = document.getElementById('filter-user');
    if (userSelect) {
        const currentValue = userSelect.value;
        userSelect.innerHTML = '<option value="">Tous les utilisateurs</option>';
        Array.from(userMap.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).forEach(user => {
            const option = document.createElement('option');
            option.value = user;
            option.textContent = user;
            userSelect.appendChild(option);
        });
        userSelect.value = currentValue;
    }
    
    // Sort and populate operations dropdown
    const actionsSelect = document.getElementById('filter-actions');
    if (actionsSelect) {
        const currentValue = actionsSelect.value;
        actionsSelect.innerHTML = '<option value="">Toutes les actions</option>';
        Array.from(uniqueOperations).sort().forEach(operation => {
            const option = document.createElement('option');
            option.value = operation;
            option.textContent = operation;
            actionsSelect.appendChild(option);
        });
        actionsSelect.value = currentValue;
    }
}

async function handleFileUpload(e) {
    e.preventDefault();

    const file = csvFileInput.files[0];
    if (!file) {
        showError('Veuillez sélectionner un fichier CSV');
        return;
    }

    // Show loading state
    submitBtn.disabled = true;
    document.getElementById('upload-spinner').style.display = 'inline-block';
    document.getElementById('submit-text').textContent = 'Traitement...';
    document.getElementById('upload-error').style.display = 'none';

    try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erreur lors du téléchargement');
        }

        const data = await response.json();
        currentSessionId = data.session_id;
        currentLogType = data.log_type;

        // Show file info
        document.getElementById('info-filename').textContent = data.filename;
        document.getElementById('info-rows').textContent = data.rows.toLocaleString();
        document.getElementById('info-columns').textContent = data.columns;
        document.getElementById('file-info').style.display = 'block';

        // Update navbar
        navbarStatus.textContent = `Session: ${currentSessionId.substring(0, 8)}... | Type: ${data.log_type}`;

        // Show dashboard
        uploadSection.style.display = 'none';
        dashboardSection.style.display = 'block';

        // Déclencher automatiquement l'analyse Exchange
        await loadAnalysisData('exchange');

    } catch (error) {
        console.error('Upload error:', error);
        showError(error.message);
    } finally {
        submitBtn.disabled = false;
        document.getElementById('upload-spinner').style.display = 'none';
        document.getElementById('submit-text').textContent = 'Analyser les données';
    }
}

async function handleAddFile() {
    const fileInput = document.getElementById('additional-csv-file');
    const file = fileInput.files[0];
    
    if (!file) {
        showAddFileError('Veuillez sélectionner un fichier CSV');
        return;
    }
    
    if (!currentSessionId) {
        showAddFileError('Aucune session active. Veuillez d\'abord charger un fichier');
        return;
    }

    // Show loading state
    const addFileSubmitBtn = document.getElementById('add-file-submit-btn');
    const addFileSpinner = document.getElementById('add-file-spinner');
    const addFileText = document.getElementById('add-file-text');
    
    addFileSubmitBtn.disabled = true;
    addFileSpinner.style.display = 'inline-block';
    addFileText.textContent = 'Ajout en cours...';
    document.getElementById('add-file-error').style.display = 'none';

    try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`/api/upload/${currentSessionId}`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erreur lors du téléchargement');
        }

        const data = await response.json();
        
        // Update file info with accumulated info
        const rowsElement = document.getElementById('info-rows');
        if (rowsElement) {
            const currentRows = parseInt(rowsElement.textContent.replace(/\s/g, ''));
            rowsElement.textContent = (currentRows + data.rows_added).toLocaleString();
        }

        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('addFileModal'));
        modal.hide();
        
        // Reset form
        document.getElementById('add-file-form').reset();
        fileInput.value = '';
        
        // Reload analysis data
        await loadAnalysisData('exchange');
        
        // Show success message
        showSuccessMessage('Fichier supplémentaire chargé avec succès');

    } catch (error) {
        console.error('Add file error:', error);
        showAddFileError(error.message);
    } finally {
        addFileSubmitBtn.disabled = false;
        addFileSpinner.style.display = 'none';
        addFileText.textContent = 'Ajouter les données';
    }
}

function showAddFileError(message) {
    const errorDiv = document.getElementById('add-file-error');
    const errorMessage = document.getElementById('add-file-error-message');
    errorMessage.textContent = message;
    errorDiv.style.display = 'block';
}

function showSuccessMessage(message) {
    const alertDiv = document.createElement('div');
    alertDiv.className = 'alert alert-success alert-dismissible fade show position-fixed top-0 end-0 m-3';
    alertDiv.style.zIndex = '9999';
    alertDiv.innerHTML = `
        <i class="fas fa-check-circle me-2"></i>${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    document.body.appendChild(alertDiv);
    
    setTimeout(() => {
        alertDiv.remove();
    }, 4000);
}

async function loadTabData(tabId) {
    // Plus d'onglets, direct Exchange
    await loadAnalysisData('exchange');
}

async function loadAnalysisData(analysisType) {
    if (!currentSessionId) return;

    try {
        const response = await fetch(`/api/analysis/${currentSessionId}/${analysisType}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(currentFilters)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erreur lors de l\'analyse');
        }

        const data = await response.json();
        analysisData[analysisType] = data;
        console.log(`Analysis data for ${analysisType}:`, data);
        displayAnalysisResults(analysisType, data);

    } catch (error) {
        console.error('Analysis error:', error);
        showError(`Erreur lors de l'analyse: ${error.message}`);
    }
}

function displayAnalysisResults(analysisType, data) {
    switch (analysisType) {
        case 'summary':
            displaySummary(data);
            break;
        case 'file_operations':
            displayFileOperations(data);
            break;
        case 'user_activity':
            displayUserActivity(data);
            break;
        case 'exchange':
            displayExchange(data);
            break;
    }
}

function displaySummary(data) {
    if (data.log_type) {
        const badgeClass = {
            'purview': 'bg-primary',
            'exchange': 'bg-success',
            'entra': 'bg-info',
            'unknown': 'bg-secondary'
        }[data.log_type] || 'bg-secondary';

        document.getElementById('summary-log-type').textContent = data.log_type.toUpperCase();
        document.getElementById('summary-log-type').className = `badge ${badgeClass}`;
    }

    document.getElementById('summary-records').textContent = data.total_records?.toLocaleString() || '0';
    document.getElementById('summary-columns').textContent = data.columns?.length || '0';
    document.getElementById('summary-size').textContent = data.file_info?.memory_usage || 'N/A';

    if (data.date_range) {
        document.getElementById('summary-start-date').textContent = formatDate(data.date_range.start);
        document.getElementById('summary-end-date').textContent = formatDate(data.date_range.end);
    }
}

function displayFileOperations(data) {
    if (data.summary) {
        document.getElementById('files-total-ops').textContent = data.summary.total_operations?.toLocaleString() || '0';
        document.getElementById('files-unique-files').textContent = data.summary.unique_files?.toLocaleString() || '0';
        document.getElementById('files-unique-users').textContent = data.summary.unique_users?.toLocaleString() || '0';
    }

    // Top files
    const topFilesTable = document.querySelector('#files-top-files tbody');
    topFilesTable.innerHTML = '';
    if (data.top_files && Object.keys(data.top_files).length > 0) {
        Object.entries(data.top_files).slice(0, 15).forEach(([file, count]) => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            row.className = 'file-row';
            row.dataset.filename = file;
            row.dataset.count = count;
            row.innerHTML = `
                <td class="text-truncate-custom" title="${file}">${file}</td>
                <td class="text-end"><span class="badge bg-primary">${count}</span></td>
            `;
            row.addEventListener('click', function() {
                const filename = this.dataset.filename;
                const fileCount = this.dataset.count;
                // Get user breakdown for this file
                const fileInfo = data.files_by_user?.[filename];
                const usersList = fileInfo?.users || [];
                const operations = fileInfo?.operations || {};
                
                const usersHtml = usersList.map(u => `<span class="badge bg-light text-dark me-2 mb-2">${u}</span>`).join('');
                const opsHtml = Object.entries(operations).map(([op, cnt]) => 
                    `<tr><td>${op}</td><td class="text-end"><span class="badge bg-info">${cnt}</span></td></tr>`
                ).join('');
                
                const content = `
                    <div class="mb-3">
                        <h6 class="text-primary"><i class="fas fa-file"></i> ${filename}</h6>
                        <p class="mb-2"><strong>Nombre d'opérations:</strong> <span class="badge bg-primary">${fileCount}</span></p>
                    </div>
                    <div class="mb-3">
                        <h6 class="mb-2"><i class="fas fa-users"></i> Utilisateurs:</h6>
                        <div>${usersHtml || 'Aucun utilisateur'}</div>
                    </div>
                    <div>
                        <h6 class="mb-3"><i class="fas fa-tasks"></i> Types d'opérations</h6>
                        <table class="table table-sm table-hover">
                            <thead>
                                <tr class="table-active">
                                    <th>Opération</th>
                                    <th class="text-end">Nombre</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${opsHtml || '<tr><td colspan="2" class="text-center text-muted">Aucune donnée</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                `;
                showDetails(`Détails - ${filename}`, content);
            });
            topFilesTable.appendChild(row);
        });
    } else {
        topFilesTable.innerHTML = '<tr><td colspan="2" class="text-center text-muted">Aucune donnée</td></tr>';
    }

    // Operations chart
    if (data.operations && Object.keys(data.operations).length > 0) {
        createOperationsChart(data.operations);
    }
    
    // Display users with operations
    const filesUsersDiv = document.getElementById('files-users-detail');
    if (filesUsersDiv) {
        filesUsersDiv.innerHTML = '';
    }
    if (filesUsersDiv && data.top_users_detail && Object.keys(data.top_users_detail).length > 0) {
        Object.entries(data.top_users_detail).slice(0, 10).forEach(([user, stats]) => {
            const opsHtml = Object.entries(stats.operations || {})
                .map(([op, count]) => `<span class="badge bg-light text-dark me-1">${op}: ${count}</span>`)
                .join('');
            
            const userHtml = `
                <div class="mb-3 p-3 border rounded bg-light">
                    <h6 class="fw-bold text-primary mb-2">${user}</h6>
                    <p class="mb-2"><small><strong>Opérations:</strong> <span class="badge bg-info">${stats.count}</span></small></p>
                    <p class="mb-2"><small><strong>Fichiers uniques:</strong> <span class="badge bg-success">${stats.files}</span></small></p>
                    <p class="mb-0"><small><strong>Opérations:</strong></small><br>${opsHtml}</p>
                </div>
            `;
            filesUsersDiv.innerHTML += userHtml;
        });
    } else {
        if (filesUsersDiv) filesUsersDiv.innerHTML = '<p class="text-center text-muted">Aucune donnée</p>';
    }
    
    // Display detailed operations by file
    const detailedOpsDiv = document.getElementById('files-detailed-ops');
    if (detailedOpsDiv) {
        detailedOpsDiv.innerHTML = '';
    }
    if (detailedOpsDiv && data.files_by_user && Object.keys(data.files_by_user).length > 0) {
        Object.entries(data.files_by_user).slice(0, 5).forEach(([file, fileStats]) => {
            const usersHtml = Array.isArray(fileStats.users) 
                ? fileStats.users.map(u => `<span class="badge bg-light text-dark">${u}</span>`).join(' ')
                : 'Aucun utilisateur';
            
            const opsHtml = Object.entries(fileStats.operations || {})
                .map(([op, count]) => `<span class="badge bg-light text-dark me-1">${op}: ${count}</span>`)
                .join('');
            
            const fileHtml = `
                <div class="mb-3 p-3 border rounded bg-light">
                    <h6 class="fw-bold text-primary mb-2"><i class="fas fa-file"></i> ${file}</h6>
                    <p class="mb-2"><small><strong>Opérations:</strong> <span class="badge bg-info">${fileStats.count}</span></small></p>
                    <p class="mb-2"><small><strong>Utilisateurs:</strong></small><br>${usersHtml}</p>
                    <p class="mb-0"><small><strong>Types:</strong></small><br>${opsHtml}</p>
                </div>
            `;
            detailedOpsDiv.innerHTML += fileHtml;
        });
    } else {
        if (detailedOpsDiv) detailedOpsDiv.innerHTML = '<p class="text-center text-muted">Aucune donnée</p>';
    }
}

function displayUserActivity(data) {
    // Top users
    const topUsersTable = document.querySelector('#users-top-users tbody');
    if (topUsersTable) {
        topUsersTable.innerHTML = '';
    }
    if (topUsersTable && data.top_users && Object.keys(data.top_users).length > 0) {
        Object.entries(data.top_users).slice(0, 10).forEach(([user, count]) => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            row.className = 'user-row';
            row.dataset.username = user;
            row.dataset.count = count;
            row.innerHTML = `
                <td class="text-truncate-custom" title="${user}">${user}</td>
                <td class="text-end"><span class="badge bg-info">${count}</span></td>
            `;
            row.addEventListener('click', function() {
                const username = this.dataset.username;
                const userCount = this.dataset.count;
                const userStats = data.user_stats?.[username];
                
                const content = `
                    <div class="mb-3">
                        <h6 class="text-primary"><i class="fas fa-user"></i> ${username}</h6>
                        <p class="mb-1"><strong>Total d'opérations:</strong> <span class="badge bg-info">${userCount}</span></p>
                        <p class="mb-1"><strong>Fichiers uniques:</strong> <span class="badge bg-success">${userStats?.unique_files || 0}</span></p>
                        <p class="mb-0"><strong>Première activité:</strong> <span class="text-monospace">${formatDate(userStats?.first_action) || '-'}</span></p>
                    </div>
                    ${userStats?.operations_breakdown ? `
                        <div>
                            <h6 class="mb-3"><i class="fas fa-tasks"></i> Opérations</h6>
                            <div class="row">
                                ${Object.entries(userStats.operations_breakdown).map(([op, cnt]) => 
                                    `<div class="col-md-6 mb-2">
                                        <span class="badge bg-light text-dark">${op}: ${cnt}</span>
                                    </div>`
                                ).join('')}
                            </div>
                        </div>
                    ` : ''}
                `;
                showDetails(`Détails - ${username}`, content);
            });
            topUsersTable.appendChild(row);
        });
    } else {
        if (topUsersTable) topUsersTable.innerHTML = '<tr><td colspan="2" class="text-center text-muted">Aucune donnée</td></tr>';
    }

    // User statistics
    const statsDiv = document.getElementById('users-stats');
    if (statsDiv) {
        statsDiv.innerHTML = '';
    }
    if (statsDiv && data.user_stats && Object.keys(data.user_stats).length > 0) {
        Object.entries(data.user_stats).slice(0, 10).forEach(([user, stats]) => {
            const statsHtml = `
                <div class="mb-3 p-3 border rounded bg-light">
                    <h6 class="fw-bold text-primary mb-2">${user}</h6>
                    <p class="mb-1"><small><strong>Opérations:</strong> ${stats.operations || 0}</small></p>
                    <p class="mb-1"><small><strong>Fichiers:</strong> ${stats.unique_files || 0}</small></p>
                    <p class="mb-0"><small class="text-muted"><strong>Début:</strong> ${formatDate(stats.first_action)}</small></p>
                </div>
            `;
            statsDiv.innerHTML += statsHtml;
        });
    } else {
        if (statsDiv) statsDiv.innerHTML = '<p class="text-center text-muted">Aucune donnée</p>';
    }
}

// Constante pour la pagination
let ITEMS_PER_PAGE = 15;

// Fonction pour obtenir le nombre d'éléments par page actuel
function getItemsPerPage() {
    const selector = document.getElementById('items-per-page');
    if (selector) {
        return parseInt(selector.value) || 15;
    }
    return ITEMS_PER_PAGE;
}

// Variable globale pour stocker les données complètes des logs
let allLogsData = {};

// Fonction pour afficher les détails du log dans la modale avancée
function showLogDetails(detail) {
    // Récupérer les données complètes du JSON AuditData
    const auditData = detail.full_data || detail;
    
    // Stocker pour les fonctions de recherche
    window.currentAuditData = auditData;
    
    // Mettre à jour la banner d'infos rapides
    const statusBadge = auditData.ResultStatus === 'Succeeded' 
        ? '<span class="badge bg-success">✓ Succès</span>'
        : auditData.ResultStatus === 'Failed'
        ? '<span class="badge bg-danger">✗ Échec</span>'
        : '<span class="badge bg-secondary">' + (auditData.ResultStatus || '-') + '</span>';
    
    document.getElementById('quick-operation').textContent = auditData.Operation || '-';
    document.getElementById('quick-user').textContent = auditData.UserId || '-';
    document.getElementById('quick-date').textContent = formatDate(auditData.CreationTime) || '-';
    document.getElementById('quick-status').innerHTML = statusBadge;
    
    // Onglet Infos
    renderInfosTab(auditData);
    
    // Onglet Folders
    renderFoldersTab(auditData);
    
    // Onglet Items (AffectedItems)
    renderItemsTab(auditData);
    
    // Onglet JSON Complet
    document.getElementById('json-complete').textContent = JSON.stringify(auditData, null, 2);
    
    // Configurer la recherche
    setupJsonSearch(auditData);
    
    // Afficher la modale
    const modal = new bootstrap.Modal(document.getElementById('logDetailsModal'));
    modal.show();
}

// Onglet Infos - Afficher les informations principales
function renderInfosTab(auditData) {
    let specificContent = '';
    
    // Gestion spéciale pour tous types d'opérations
    if (auditData.Operation) {
        specificContent = renderOperationDetails(auditData.Operation, auditData);
    }
    
    const infosHtml = `
        <div class="info-section">
            <h6 class="info-section-title">Informations Principales</h6>
            <div class="info-section-content">
                <div class="json-item">
                    <span class="json-key">Date:</span>
                    <span class="json-value">${formatDate(auditData.CreationTime)}</span>
                </div>
                <div class="json-item">
                    <span class="json-key">Opération:</span>
                    <span class="json-value"><strong>${auditData.Operation || '-'}</strong></span>
                </div>
                <div class="json-item">
                    <span class="json-key">Utilisateur:</span>
                    <span class="json-value">${auditData.UserId || '-'}</span>
                </div>
                <div class="json-item">
                    <span class="json-key">Statut:</span>
                    <span class="json-value">${auditData.ResultStatus || '-'}</span>
                </div>
                <div class="json-item">
                    <span class="json-key">Workload:</span>
                    <span class="json-value">${auditData.Workload || '-'}</span>
                </div>
                <div class="json-item">
                    <span class="json-key">IP Client:</span>
                    <span class="json-value">${auditData.ClientIP || auditData.ClientIPAddress || '-'}</span>
                </div>
                <div class="json-item">
                    <span class="json-key">Info Client:</span>
                    <span class="json-value">${auditData.ClientInfoString || '-'}</span>
                </div>
            </div>
        </div>
        ${specificContent}
    `;
    
    document.getElementById('infos-container').innerHTML = infosHtml;
}

// Fonction générale pour afficher les détails d'opérations
function renderOperationDetails(operation, auditData) {
    if (operation.includes('InboxRule')) {
        return renderRuleDetails(auditData);
    } else if (operation === 'Update') {
        return renderUpdateDetails(auditData);
    } else if (operation === 'MailItemsAccessed') {
        return renderMailAccessDetails(auditData);
    } else if (operation === 'MoveToDeletedItems') {
        return renderMoveDetails(auditData);
    } else if (operation === 'TIMailData') {
        return renderTIMailDataDetails(auditData);
    } else {
        return renderGenericOperationDetails(operation, auditData);
    }
}

// Fonction spécifique pour afficher les détails des règles
function renderRuleDetails(auditData) {
    if (!auditData.Parameters || !Array.isArray(auditData.Parameters)) {
        return '';
    }
    
    const parameters = {};
    auditData.Parameters.forEach(param => {
        if (param.Name && param.Value !== undefined) {
            parameters[param.Name] = param.Value;
        }
    });
    
    const ruleHtml = `
        <div class="info-section mt-3">
            <h6 class="info-section-title">Détails de la Règle</h6>
            <div class="info-section-content">
                ${parameters.Name ? `
                <div class="json-item">
                    <span class="json-key">Nom de la règle:</span>
                    <span class="json-value"><strong>"${parameters.Name}"</strong></span>
                </div>
                ` : ''}
                
                <div class="json-subsection mt-3">
                    <h6 class="text-primary"><i class="fas fa-filter me-2"></i>Conditions</h6>
                    ${parameters.From ? `
                    <div class="json-item">
                        <span class="json-key">De (From):</span>
                        <span class="json-value"><code>${parameters.From}</code></span>
                    </div>
                    ` : ''}
                    ${parameters.SubjectContainsWords ? `
                    <div class="json-item">
                        <span class="json-key">Sujet contient:</span>
                        <span class="json-value"><code>${parameters.SubjectContainsWords}</code></span>
                    </div>
                    ` : ''}
                    ${parameters.BodyContainsWords ? `
                    <div class="json-item">
                        <span class="json-key">Corps contient:</span>
                        <span class="json-value"><code>${parameters.BodyContainsWords}</code></span>
                    </div>
                    ` : ''}
                    ${parameters.SentTo ? `
                    <div class="json-item">
                        <span class="json-key">Envoyé à:</span>
                        <span class="json-value"><code>${parameters.SentTo}</code></span>
                    </div>
                    ` : ''}
                    ${!parameters.From && !parameters.SubjectContainsWords && !parameters.BodyContainsWords && !parameters.SentTo ? 
                        '<div class="text-muted"><em>Aucune condition définie</em></div>' : ''}
                </div>

                <div class="json-subsection mt-3">
                    <h6 class="text-success"><i class="fas fa-cog me-2"></i>Actions</h6>
                    ${parameters.DeleteMessage === 'True' ? `
                    <div class="json-item">
                        <span class="json-key">Supprimer le message:</span>
                        <span class="json-value text-danger"><strong>Oui</strong></span>
                    </div>
                    ` : ''}
                    ${parameters.MoveToFolder ? `
                    <div class="json-item">
                        <span class="json-key">Déplacer vers:</span>
                        <span class="json-value"><code>${parameters.MoveToFolder}</code></span>
                    </div>
                    ` : ''}
                    ${parameters.MarkAsRead === 'True' ? `
                    <div class="json-item">
                        <span class="json-key">Marquer comme lu:</span>
                        <span class="json-value text-info"><strong>Oui</strong></span>
                    </div>
                    ` : ''}
                    ${parameters.ForwardTo ? `
                    <div class="json-item">
                        <span class="json-key">Transférer à:</span>
                        <span class="json-value"><code>${parameters.ForwardTo}</code></span>
                    </div>
                    ` : ''}
                    ${parameters.RedirectTo ? `
                    <div class="json-item">
                        <span class="json-key">Rediriger vers:</span>
                        <span class="json-value"><code>${parameters.RedirectTo}</code></span>
                    </div>
                    ` : ''}
                    ${parameters.StopProcessingRules === 'True' ? `
                    <div class="json-item">
                        <span class="json-key">Arrêter le traitement des règles:</span>
                        <span class="json-value text-warning"><strong>Oui</strong></span>
                    </div>
                    ` : ''}
                    ${!parameters.DeleteMessage && !parameters.MoveToFolder && !parameters.MarkAsRead && !parameters.ForwardTo && !parameters.RedirectTo && !parameters.StopProcessingRules ? 
                        '<div class="text-muted"><em>Aucune action définie</em></div>' : ''}
                </div>
            </div>
        </div>
    `;
    
    return ruleHtml;
}

// Fonction pour afficher les détails des opérations Update
function renderUpdateDetails(auditData) {
    const item = auditData.Item || {};
    const modifiedProps = auditData.ModifiedProperties || [];
    
    return `
        <div class="info-section mt-3">
            <h6 class="info-section-title">Détails de la Mise à Jour</h6>
            <div class="info-section-content">
                ${item.Subject ? `
                    <div class="json-item">
                        <span class="json-key">Sujet:</span>
                        <span class="json-value"><strong>"${item.Subject}"</strong></span>
                    </div>
                ` : ''}
                
                ${item.ParentFolder?.Path ? `
                    <div class="json-item">
                        <span class="json-key">Dossier:</span>
                        <span class="json-value"><code>${item.ParentFolder.Path.replace(/\\\\/g, '/')}</code></span>
                    </div>
                ` : ''}
                
                ${item.SizeInBytes ? `
                    <div class="json-item">
                        <span class="json-key">Taille:</span>
                        <span class="json-value">${Math.round(item.SizeInBytes / 1024)} KB</span>
                    </div>
                ` : ''}
                
                ${modifiedProps.length > 0 ? `
                <div class="json-subsection mt-3">
                    <h6 class="text-warning"><i class="fas fa-edit me-2"></i>Propriétés Modifiées</h6>
                    ${modifiedProps.map(prop => {
                        const propLabels = {
                            'RecipientCollection': 'Destinataires',
                            'AllAttachmentsHidden': 'Pièces jointes cachées',
                            'ItemClass': 'Type d\'élément',
                            'Subject': 'Sujet',
                            'Body': 'Corps du message'
                        };
                        return `
                            <span class="json-item">
                                <span class="json-value badge bg-warning text-dark">${propLabels[prop] || prop}</span>
                            </span>
                        `;
                    }).join('')}
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// Fonction pour afficher les détails d'accès aux messages
function renderMailAccessDetails(auditData) {
    const folders = auditData.Folders || [];
    const operationProps = auditData.OperationProperties || [];
    const accessType = operationProps.find(p => p.Name === 'MailAccessType')?.Value || 'Unknown';
    
    const accessTypeLabels = {
        'Bind': 'Consultation',
        'Sync': 'Synchronisation',
        'Search': 'Recherche'
    };
    
    return `
        <div class="info-section mt-3">
            <h6 class="info-section-title">Détails d'Accès aux Messages</h6>
            <div class="info-section-content">
                <div class="json-item">
                    <span class="json-key">Type d'Accès:</span>
                    <span class="json-value badge bg-info">${accessTypeLabels[accessType] || accessType}</span>
                </div>
                
                ${folders.length > 0 ? `
                <div class="mt-3">
                    <h6 class="text-primary mb-2"><i class="fas fa-folder me-2"></i>Dossiers Consultés (${folders.length})</h6>
                    ${folders.slice(0, 5).map(folder => `
                        <div class="json-item">
                            <span class="json-key">Dossier:</span>
                            <span class="json-value">${folder.FolderItems?.length || 0} élément(s)</span>
                        </div>
                        ${folder.FolderItems?.slice(0, 2).map(item => `
                            <div class="ms-3 mt-1">
                                <small class="text-muted">"${item.Subject || 'Sans sujet'}"</small>
                            </div>
                        `).join('') || ''}
                    `).join('')}
                    ${folders.length > 5 ? `<div class="text-muted mt-2"><em>... et ${folders.length - 5} autres dossiers</em></div>` : ''}
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// Fonction pour afficher les détails de suppression
function renderMoveDetails(auditData) {
    const affectedItems = auditData.AffectedItems || [];
    const sourceFolder = auditData.Folder?.Path?.replace(/\\\\/g, '/');
    const destFolder = auditData.DestFolder?.Path?.replace(/\\\\/g, '/');
    
    return `
        <div class="info-section mt-3">
            <h6 class="info-section-title">Détails de Suppression</h6>
            <div class="info-section-content">
                <div class="json-item">
                    <span class="json-key">Éléments Affectés:</span>
                    <span class="json-value badge bg-danger">${affectedItems.length}</span>
                </div>
                
                ${sourceFolder ? `
                <div class="json-item">
                    <span class="json-key">Dossier Source:</span>
                    <span class="json-value"><code>${sourceFolder}</code></span>
                </div>
                ` : ''}
                
                ${destFolder ? `
                <div class="json-item">
                    <span class="json-key">Dossier Destination:</span>
                    <span class="json-value"><code>${destFolder}</code></span>
                </div>
                ` : ''}
                
                ${affectedItems.length > 0 ? `
                <div class="json-subsection mt-3">
                    <h6 class="text-danger"><i class="fas fa-trash me-2"></i>Éléments Supprimés</h6>
                    ${affectedItems.slice(0, 5).map(item => `
                    <div class="json-item">
                        <span class="json-key">Élément:</span>
                        <span class="json-value">"${item.Subject || 'Sans sujet'}"</span>
                    </div>
                    ${item.InternetMessageId ? `<div class="json-item ms-3"><small class="text-muted">ID: ${item.InternetMessageId}</small></div>` : ''}
                    `).join('')}
                    ${affectedItems.length > 5 ? `<div class="text-muted mt-2"><em>... et ${affectedItems.length - 5} autres éléments</em></div>` : ''}
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// Fonction pour afficher les détails des données Threat Intelligence Mail
function renderTIMailDataDetails(auditData) {
    const recipientList = auditData.Recipients || [];
    const attachments = auditData.AttachmentData || [];
    const authDetails = auditData.AuthDetails || [];
    const threats = auditData.ThreatsAndDetectionTech || [];
    
    // Déterminer la couleur du verdict
    const verdictColors = {
        'Phish': 'danger',
        'Malware': 'danger',
        'Spam': 'warning',
        'Clean': 'success',
        'Unknown': 'secondary'
    };
    const verdictColor = verdictColors[auditData.Verdict] || 'secondary';
    
    return `
        <div class="info-section mt-3">
            <h6 class="info-section-title">
                <i class="fas fa-shield-alt me-2"></i> Threat Intelligence - Détails du Mail
            </h6>
            <div class="info-section-content">
                <!-- Sujet et Verdict -->
                <div class="json-item">
                    <span class="json-key">Sujet:</span>
                    <span class="json-value"><strong>"${auditData.Subject || '-'}"</strong></span>
                </div>
                
                <div class="json-item">
                    <span class="json-key">Verdict:</span>
                    <span class="json-value"><span class="badge bg-${verdictColor}">${auditData.Verdict || 'Unknown'}</span></span>
                </div>
                
                ${auditData.PhishConfidenceLevel ? `
                <div class="json-item">
                    <span class="json-key">Niveau de confiance Phish:</span>
                    <span class="json-value"><strong>${auditData.PhishConfidenceLevel}</strong></span>
                </div>
                ` : ''}
                
                <!-- Expéditeur et Destinataires -->
                <div class="json-subsection mt-3">
                    <h6 class="text-info"><i class="fas fa-envelope me-2"></i>Informations d'Email</h6>
                    
                    <div class="json-item">
                        <span class="json-key">Expéditeur (P1):</span>
                        <span class="json-value"><code>${auditData.P1Sender || '-'}</code></span>
                    </div>
                    
                    ${auditData.P2Sender && auditData.P2Sender !== auditData.P1Sender ? `
                    <div class="json-item">
                        <span class="json-key">Expéditeur (P2):</span>
                        <span class="json-value"><code>${auditData.P2Sender}</code></span>
                    </div>
                    ` : ''}
                    
                    ${recipientList.length > 0 ? `
                    <div class="json-item">
                        <span class="json-key">Destinataires:</span>
                        <span class="json-value">
                            <ul class="list-unstyled mb-0 ms-3">
                                ${recipientList.map(r => `<li><code>${r}</code></li>`).join('')}
                            </ul>
                        </span>
                    </div>
                    ` : ''}
                    
                    <div class="json-item">
                        <span class="json-key">IP Expéditeur:</span>
                        <span class="json-value"><code>${auditData.SenderIp || '-'}</code></span>
                    </div>
                </div>
                
                <!-- Détection des Menaces -->
                ${threats.length > 0 ? `
                <div class="json-subsection mt-3">
                    <h6 class="text-danger"><i class="fas fa-exclamation-triangle me-2"></i>Menaces Détectées</h6>
                    ${threats.map(threat => `
                    <div class="json-item">
                        <span class="json-value badge bg-danger">${threat}</span>
                    </div>
                    `).join('')}
                    
                    ${auditData.DetectionMethod ? `
                    <div class="json-item mt-2">
                        <span class="json-key">Méthode de détection:</span>
                        <span class="json-value">${auditData.DetectionMethod}</span>
                    </div>
                    ` : ''}
                    
                    ${auditData.DetectionType ? `
                    <div class="json-item">
                        <span class="json-key">Type de détection:</span>
                        <span class="json-value">${auditData.DetectionType}</span>
                    </div>
                    ` : ''}
                </div>
                ` : ''}
                
                <!-- Authentification -->
                ${authDetails.length > 0 ? `
                <div class="json-subsection mt-3">
                    <h6 class="text-success"><i class="fas fa-check-circle me-2"></i>Vérifications d'Authentification</h6>
                    ${authDetails.map(auth => {
                        const isPass = auth.Value === 'Pass' || auth.Value === 'pass';
                        return `
                        <div class="json-item">
                            <span class="json-key">${auth.Name}:</span>
                            <span class="json-value">
                                <span class="badge ${isPass ? 'bg-success' : 'bg-warning'} text-white">
                                    ${auth.Value}
                                </span>
                            </span>
                        </div>
                        `;
                    }).join('')}
                </div>
                ` : ''}
                
                <!-- Pièces jointes -->
                ${attachments.length > 0 ? `
                <div class="json-subsection mt-3">
                    <h6 class="text-warning"><i class="fas fa-paperclip me-2"></i>Pièces Jointes (${attachments.length})</h6>
                    <div style="max-height: 300px; overflow-y: auto;">
                        <table class="table table-sm table-borderless mb-0">
                            <thead class="table-light">
                                <tr>
                                    <th>Nom</th>
                                    <th>Type</th>
                                    <th>Verdict</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${attachments.map(att => {
                                    const verdictText = att.FileVerdict === 0 ? 'Clean' : 'Suspicious';
                                    const verdictClass = att.FileVerdict === 0 ? 'success' : 'warning';
                                    return `
                                    <tr>
                                        <td><small><code>${att.FileName || '-'}</code></small></td>
                                        <td><small>${att.FileType || '-'}</small></td>
                                        <td><small><span class="badge bg-${verdictClass}">${verdictText}</span></small></td>
                                    </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ` : ''}
                
                <!-- Statuts de Livraison -->
                <div class="json-subsection mt-3">
                    <h6 class="text-muted"><i class="fas fa-info-circle me-2"></i>Statut de Livraison</h6>
                    
                    ${auditData.DeliveryAction ? `
                    <div class="json-item">
                        <span class="json-key">Action de livraison:</span>
                        <span class="json-value">${auditData.DeliveryAction}</span>
                    </div>
                    ` : ''}
                    
                    ${auditData.OriginalDeliveryLocation ? `
                    <div class="json-item">
                        <span class="json-key">Emplacement de livraison d'origine:</span>
                        <span class="json-value"><code>${auditData.OriginalDeliveryLocation}</code></span>
                    </div>
                    ` : ''}
                    
                    ${auditData.LatestDeliveryLocation ? `
                    <div class="json-item">
                        <span class="json-key">Dernier emplacement de livraison:</span>
                        <span class="json-value"><code>${auditData.LatestDeliveryLocation}</code></span>
                    </div>
                    ` : ''}
                </div>
                
                <!-- Timestamps -->
                <div class="json-subsection mt-3">
                    <h6 class="text-muted"><i class="fas fa-clock me-2"></i>Horodatages</h6>
                    
                    ${auditData.CreationTime ? `
                    <div class="json-item">
                        <span class="json-key">Créé le:</span>
                        <span class="json-value"><small>${formatDate(auditData.CreationTime)}</small></span>
                    </div>
                    ` : ''}
                    
                    ${auditData.MessageTime ? `
                    <div class="json-item">
                        <span class="json-key">Temps du message:</span>
                        <span class="json-value"><small>${formatDate(auditData.MessageTime)}</small></span>
                    </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
}

// Fonction pour afficher les détails d'opérations génériques
function renderGenericOperationDetails(operation, auditData) {
    const item = auditData.Item || {};
    const parameters = auditData.Parameters || [];
    
    const operationLabels = {
        'Send': 'Envoi de Message',
        'Create': 'Création d\'Élément',
        'Copy': 'Copie d\'Élément',
        'Move': 'Déplacement',
        'HardDelete': 'Suppression Définitive',
        'SoftDelete': 'Suppression Temporaire'
    };
    
    const title = operationLabels[operation] || operation;
    
    return `
        <div class="info-section mt-3">
            <h6 class="info-section-title">Détails de l'Opération: ${title}</h6>
            <div class="info-section-content">
                ${item.Subject ? `
                <div class="json-item">
                    <span class="json-key">Élément:</span>
                    <span class="json-value"><strong>"${item.Subject}"</strong></span>
                </div>
                ` : ''}
                
                ${item.ParentFolder?.Path ? `
                <div class="json-item">
                    <span class="json-key">Dossier:</span>
                    <span class="json-value"><code>${item.ParentFolder.Path.replace(/\\\\/g, '/')}</code></span>
                </div>
                ` : ''}
                
                ${parameters.length > 0 && parameters.length <= 10 ? `
                <div class="json-subsection mt-3">
                    <h6 class="text-info"><i class="fas fa-cogs me-2"></i>Paramètres</h6>
                    ${parameters.map(param => `
                    <div class="json-item">
                        <span class="json-key">${param.Name}:</span>
                        <span class="json-value"><code>${param.Value}</code></span>
                    </div>
                    `).join('')}
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// Onglet Folders - Afficher les dossiers et items
function renderFoldersTab(auditData) {
    if (!auditData.Folders || auditData.Folders.length === 0) {
        document.getElementById('folders-container').innerHTML = '<div class="alert alert-info">Aucun dossier dans ce log</div>';
        return;
    }

    let foldersHtml = '';
    auditData.Folders.forEach((folder, idx) => {
        foldersHtml += `
            <div class="info-section">
                <h6 class="info-section-title">Dossier: ${folder.Path || 'N/A'}</h6>
                <div class="info-section-content">
                    ${folder.FolderItems ? folder.FolderItems.map((item, itemIdx) => `
                        <div class="json-item" style="margin-bottom: 15px; border-left: 3px solid #6c757d;">
                            <div><span class="json-key">Sujet:</span> <span class="json-value">${item.Subject || 'N/A'}</span></div>
                            <div><span class="json-key">Taille:</span> <span class="json-value">${item.SizeInBytes ? formatBytes(item.SizeInBytes) : 'N/A'}</span></div>
                            <div><span class="json-key">Date Création:</span> <span class="json-value">${formatDate(item.CreationTime)}</span></div>
                            <div><span class="json-key">InternetMessageId:</span> <span class="json-value" style="font-size: 0.8rem;">${item.InternetMessageId || '-'}</span></div>
                        </div>
                    `).join('') : '<div class="alert alert-sm alert-info m-0">Aucun item</div>'}
                </div>
            </div>
        `;
    });
    
    document.getElementById('folders-container').innerHTML = foldersHtml;
}

// Onglet Items - Afficher les AffectedItems
function renderItemsTab(auditData) {
    let itemsHtml = '';
    
    // AffectedItems (SoftDelete, HardDelete, etc.)
    if (auditData.AffectedItems && auditData.AffectedItems.length > 0) {
        itemsHtml += `
            <div class="info-section">
                <h6 class="info-section-title">Éléments Affectés (${auditData.AffectedItems.length})</h6>
                <div class="info-section-content">
                    ${auditData.AffectedItems.map((item, idx) => `
                        <div class="json-item" style="border-left: 3px solid #dc3545;">
                            <div><span class="json-key">Sujet:</span> <span class="json-value">${item.Subject || 'N/A'}</span></div>
                            <div><span class="json-key">Dossier Parent:</span> <span class="json-value">${item.ParentFolder?.Path || 'N/A'}</span></div>
                            <div><span class="json-key">Pièces jointes:</span> <span class="json-value">${item.Attachments || 'Aucune'}</span></div>
                            <div><span class="json-key">InternetMessageId:</span> <span class="json-value" style="font-size: 0.8rem;">${item.InternetMessageId || '-'}</span></div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Item (pour Send, etc.)
    if (auditData.Item) {
        itemsHtml += `
            <div class="info-section">
                <h6 class="info-section-title">Détails Item</h6>
                <div class="info-section-content">
                    <div><span class="json-key">Sujet:</span> <span class="json-value">${auditData.Item.Subject || 'N/A'}</span></div>
                    <div><span class="json-key">Taille:</span> <span class="json-value">${formatBytes(auditData.Item.SizeInBytes)}</span></div>
                    <div><span class="json-key">Dossier Parent:</span> <span class="json-value">${auditData.Item.ParentFolder?.Path || 'N/A'}</span></div>
                    <div><span class="json-key">Pièces jointes:</span> <span class="json-value">${auditData.Item.Attachments || 'Aucune'}</span></div>
                </div>
            </div>
        `;
    }

    if (!itemsHtml) {
        itemsHtml = '<div class="alert alert-info">Aucun élément pour ce log</div>';
    }

    document.getElementById('items-container').innerHTML = itemsHtml;
}

// Fonction pour basculer les sections expand/collapse
// Fonction de recherche dans le JSON
function setupJsonSearch(auditData) {
    const searchInput = document.getElementById('json-search');
    const clearBtn = document.getElementById('search-clear');
    
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase();
        if (query.length > 0) {
            highlightSearchResults(query, auditData);
        } else {
            clearSearch();
        }
    });
    
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearSearch();
    });
}

function highlightSearchResults(query, auditData) {
    const jsonComplete = document.getElementById('json-complete');
    let json = JSON.stringify(auditData, null, 2);
    
    // Créer une version avec surlignage
    const highlighted = json.replace(
        new RegExp(`(${query})`, 'gi'),
        '<span class="search-match">$1</span>'
    );
    
    jsonComplete.innerHTML = highlighted;
}

function clearSearch() {
    const jsonComplete = document.getElementById('json-complete');
    if (window.currentAuditData) {
        jsonComplete.textContent = JSON.stringify(window.currentAuditData, null, 2);
    }
}

// Fonctions utilitaires
function formatDate(dateString) {
    if (!dateString) return '-';
    try {
        return new Date(dateString).toLocaleString('fr-FR');
    } catch (e) {
        return dateString;
    }
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function getLogonTypeLabel(logonType) {
    const labels = {
        0: 'Utilisateur',
        1: 'Délégué',
        2: 'Transport',
        3: 'RemoteUserAccount',
        4: 'ServiceAccount',
        5: 'SystemAccount'
    };
    return labels[logonType] || 'Inconnu (' + logonType + ')';
}

// Fonction pour créer une table paginée
function createPaginatedTable(operationDetails, operationType) {
    const itemsPerPage = getItemsPerPage();
    const totalPages = Math.ceil(operationDetails.length / itemsPerPage);
    let currentPage = 1;

    const tableHTML = operationDetails.length > 0 ? 
        operationDetails.map((detail, index) => `
            <tr style="cursor: pointer;" data-operation-type="${operationType}" data-detail-index="${index}">
                <td><small class="text-muted">${detail.timestamp ? new Date(detail.timestamp).toLocaleString('fr-FR') : '-'}</small></td>
                <td><small title="${detail.subject || ''}">${detail.subject || '-'}</small></td>
                <td><small>${detail.folder || '-'}</small></td>
                <td style="text-align: right;"><small>${detail.size ? (detail.size / 1024).toFixed(1) + ' KB' : '-'}</small></td>
            </tr>
        `).join('')
        : '<tr><td colspan="4" class="text-center text-muted py-2">Aucun détail disponible</td></tr>';

    const paginationHTML = totalPages > 1 ? `
        <div class="d-flex justify-content-between align-items-center mt-3">
            <small class="text-muted">
                ${operationDetails.length} enregistrement(s)
            </small>
            <nav aria-label="Pagination">
                <ul class="pagination pagination-sm mb-0">
                    <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
                        <a class="page-link" href="#" onclick="changePage(event, this, 'prev', '${operationType}', ${totalPages}); return false;">Précédent</a>
                    </li>
                    <li class="page-item active"><span class="page-link" id="page-info-${operationType}">Page 1 / ${totalPages}</span></li>
                    <li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
                        <a class="page-link" href="#" onclick="changePage(event, this, 'next', '${operationType}', ${totalPages}); return false;">Suivant</a>
                    </li>
                </ul>
            </nav>
        </div>
    ` : '';

    return { tableHTML, paginationHTML, totalPages, totalItems: operationDetails.length };
}

// Fonction pour changer de page
function changePage(event, element, direction, operationType, totalPages) {
    event.preventDefault();
    const pageInfo = document.getElementById(`page-info-${operationType}`);
    if (!pageInfo) return;
    
    const match = pageInfo.textContent.match(/Page (\d+)/);
    let currentPage = match ? parseInt(match[1]) : 1;
    
    if (direction === 'next' && currentPage < totalPages) {
        currentPage++;
    } else if (direction === 'prev' && currentPage > 1) {
        currentPage--;
    }
    
    pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
    
    // Mettre à jour l'affichage des lignes
    updateTablePage(operationType, currentPage);
    
    // Mettre à jour l'état des boutons prev/next
    const pagination = element.closest('.pagination');
    if (pagination) {
        const links = pagination.querySelectorAll('a.page-link');
        links.forEach(link => {
            if (link.textContent.includes('Précédent')) {
                link.parentElement.classList.toggle('disabled', currentPage === 1);
            } else if (link.textContent.includes('Suivant')) {
                link.parentElement.classList.toggle('disabled', currentPage === totalPages);
            }
        });
    }
}

// Fonction pour mettre à jour l'affichage de la page
function updateTablePage(operationType, pageNumber) {
    const rows = document.querySelectorAll(`tr[data-operation-type="${operationType}"]`);
    const itemsPerPage = getItemsPerPage();
    const startIdx = (pageNumber - 1) * itemsPerPage;
    const endIdx = startIdx + itemsPerPage;
    
    rows.forEach((row, index) => {
        row.style.display = (index >= startIdx && index < endIdx) ? '' : 'none';
    });
}

function initializeTimelinePagination(operations) {
    const timelineTable = document.querySelector('#exchange-timeline tbody');
    const paginationNav = document.getElementById('timeline-pagination');
    const pageInfo = document.getElementById('timeline-page-info');
    const TIMELINE_ITEMS_PER_PAGE = getItemsPerPage();
    
    const totalPages = Math.ceil(operations.length / TIMELINE_ITEMS_PER_PAGE);
    
    if (totalPages <= 1) {
        paginationNav.style.display = 'none';
    } else {
        paginationNav.style.display = 'block';
    }
    
    // Store pagination info globally
    window.timelineCurrentPage = 1;
    window.timelinePageInfo = pageInfo;
    window.timelineTotalPages = totalPages;
    window.timelineCurrentOperations = operations;  // Store the operations being paginated
    
    // Render first page
    updateTimelinePage(1);
}

function updateTimelinePage(pageNumber) {
    const timelineTable = document.querySelector('#exchange-timeline tbody');
    const operations = window.timelineCurrentOperations || window.timelineAllOperations || [];
    const TIMELINE_ITEMS_PER_PAGE = getItemsPerPage();
    const startIdx = (pageNumber - 1) * TIMELINE_ITEMS_PER_PAGE;
    const endIdx = startIdx + TIMELINE_ITEMS_PER_PAGE;
    const pageOps = operations.slice(startIdx, endIdx);
    
    timelineTable.innerHTML = '';
    const visibleCols = AVAILABLE_COLUMNS.filter(col => col.visible);
    
    pageOps.forEach((op, pageIndex) => {
        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        
        let htmlContent = '';
        visibleCols.forEach(col => {
            const value = getColumnValue(op, col.key);
            htmlContent += `<td>${value}</td>`;
        });
        row.innerHTML = htmlContent;
        
        // Add click event to show details modal
        row.addEventListener('click', () => {
            showLogDetails({
                timestamp: op.timestamp || '',
                operation: op.operation || '',
                subject: op.subject || '',
                folder: op.folder || '',
                size: op.size || 0,
                user: op.user || '',
                full_data: op.full_data || null  // Passer les données complètes
            });
        });
        
        // Hover effect
        row.addEventListener('mouseenter', () => {
            row.style.backgroundColor = '#f0f0f0';
        });
        row.addEventListener('mouseleave', () => {
            row.style.backgroundColor = '';
        });
        
        timelineTable.appendChild(row);
    });
    
    // Update page info
    if (window.timelinePageInfo) {
        window.timelinePageInfo.textContent = `Page ${pageNumber} / ${window.timelineTotalPages}`;
    }
    
    window.timelineCurrentPage = pageNumber;
    
    // Update button states
    const firstBtn = document.querySelector('a[data-timeline-direction="first"]');
    const prev10Btn = document.querySelector('a[data-timeline-direction="prev-10"]');
    const prev5Btn = document.querySelector('a[data-timeline-direction="prev-5"]');
    const prevBtn = document.querySelector('a[data-timeline-direction="prev"]');
    const nextBtn = document.querySelector('a[data-timeline-direction="next"]');
    const next5Btn = document.querySelector('a[data-timeline-direction="next-5"]');
    const next10Btn = document.querySelector('a[data-timeline-direction="next-10"]');
    const lastBtn = document.querySelector('a[data-timeline-direction="last"]');
    
    // Disable "first" and "prev" buttons at page 1
    if (firstBtn) {
        firstBtn.parentElement.classList.toggle('disabled', pageNumber === 1);
    }
    if (prev10Btn) {
        prev10Btn.parentElement.classList.toggle('disabled', pageNumber === 1);
    }
    if (prev5Btn) {
        prev5Btn.parentElement.classList.toggle('disabled', pageNumber === 1);
    }
    if (prevBtn) {
        prevBtn.parentElement.classList.toggle('disabled', pageNumber === 1);
    }
    
    // Disable "next", "next-5", "next-10", and "last" buttons at last page
    if (nextBtn) {
        nextBtn.parentElement.classList.toggle('disabled', pageNumber === window.timelineTotalPages);
    }
    if (next5Btn) {
        next5Btn.parentElement.classList.toggle('disabled', pageNumber === window.timelineTotalPages);
    }
    if (next10Btn) {
        next10Btn.parentElement.classList.toggle('disabled', pageNumber === window.timelineTotalPages);
    }
    if (lastBtn) {
        lastBtn.parentElement.classList.toggle('disabled', pageNumber === window.timelineTotalPages);
    }
}

function changeTimelinePage(event, direction) {
    event.preventDefault();
    
    const currentPage = window.timelineCurrentPage || 1;
    const totalPages = window.timelineTotalPages || 1;
    let newPage = currentPage;
    
    switch(direction) {
        case 'first':
            newPage = 1;
            break;
        case 'prev-10':
            newPage = Math.max(1, currentPage - 10);
            break;
        case 'prev-5':
            newPage = Math.max(1, currentPage - 5);
            break;
        case 'prev':
            newPage = Math.max(1, currentPage - 1);
            break;
        case 'next':
            newPage = Math.min(totalPages, currentPage + 1);
            break;
        case 'next-5':
            newPage = Math.min(totalPages, currentPage + 5);
            break;
        case 'next-10':
            newPage = Math.min(totalPages, currentPage + 10);
            break;
        case 'last':
            newPage = totalPages;
            break;
    }
    
    if (newPage !== currentPage) {
        updateTimelinePage(newPage);
    }
}

function displayExchange(data) {
    // Update badges only (removed KPI section)
    document.getElementById('badge-timeline').textContent = data.total_operations?.toLocaleString() || '0';

    // 2. Chronologie complète (avec filtres)
    const timelineTable = document.querySelector('#exchange-timeline tbody');
    if (timelineTable && data.detailed_operations) {
        timelineTable.innerHTML = '';
        
        // Trier par date décroissante
        const sorted = [...data.detailed_operations].sort((a, b) => {
            const dateA = new Date(a.timestamp || 0);
            const dateB = new Date(b.timestamp || 0);
            return dateB - dateA;
        });
        
        // Store sorted operations globally for pagination
        // Store original operations for filtering
        window.timelineOriginalOperations = sorted;
        window.timelineAllOperations = sorted;
        
        // Populate filter dropdowns with unique values
        populateFilterDropdowns(sorted);
        
        // Render table header with columns
        renderTableHeader();
        
        if (sorted.length === 0) {
            timelineTable.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">Aucune donnée</td></tr>';
        } else {
            // Initialize timeline pagination
            initializeTimelinePagination(sorted);
            
            // Analyze patterns
            analyzePatterns(sorted);
        }
    }
}

function analyzePatterns(operations) {
    if (!operations || operations.length === 0) {
        document.getElementById('badge-patterns').textContent = '0';
        return;
    }

    // Count pattern occurrences
    const patterns = {
        userIp: {},      // user -> ip -> count
        userOp: {},      // user -> operation -> count
        opIp: {},        // operation -> ip -> count
        userOpIp: {}     // user -> operation -> ip -> count
    };

    operations.forEach(op => {
        const user = op.user || 'Inconnu';
        const ip = op.ClientIP || op.client_ip || op.ClientIPAddress || op.SenderIp || 'Inconnu';
        const operation = op.operation || 'Inconnu';

        // User + IP pattern
        if (!patterns.userIp[user]) patterns.userIp[user] = {};
        patterns.userIp[user][ip] = (patterns.userIp[user][ip] || 0) + 1;

        // User + Operation pattern
        if (!patterns.userOp[user]) patterns.userOp[user] = {};
        patterns.userOp[user][operation] = (patterns.userOp[user][operation] || 0) + 1;

        // Operation + IP pattern
        if (!patterns.opIp[operation]) patterns.opIp[operation] = {};
        patterns.opIp[operation][ip] = (patterns.opIp[operation][ip] || 0) + 1;

        // User + Operation + IP pattern
        const key = `${user}|${operation}|${ip}`;
        patterns.userOpIp[key] = (patterns.userOpIp[key] || 0) + 1;
    });

    // Render patterns in tables
    renderPatternTable('pattern-user-ip', patterns.userIp, 2);
    renderPatternTable('pattern-user-op', patterns.userOp, 2);
    renderPatternTable('pattern-op-ip', patterns.opIp, 2);
    renderComplexPatternTable('pattern-user-op-ip', patterns.userOpIp);

    // Update badge with total unique patterns
    const totalPatterns = Object.keys(patterns.userOpIp).length;
    document.getElementById('badge-patterns').textContent = totalPatterns.toLocaleString();
}

function renderPatternTable(tableId, patterns, columnCount) {
    const table = document.getElementById(tableId);
    if (!table) return;

    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';

    // Flatten patterns to arrays and sort by count
    const items = [];
    Object.keys(patterns).forEach(key1 => {
        Object.keys(patterns[key1]).forEach(key2 => {
            items.push({
                col1: key1,
                col2: key2,
                count: patterns[key1][key2]
            });
        });
    });

    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${columnCount + 1}" class="text-center text-muted py-3"><small>Aucun pattern détecté</small></td></tr>`;
        return;
    }

    // Sort by count descending (top 50)
    items.sort((a, b) => b.count - a.count);
    items.slice(0, 50).forEach(item => {
        const row = document.createElement('tr');
        const countBadgeClass = item.count > 20 ? 'danger' : item.count > 10 ? 'warning' : 'info';
        row.innerHTML = `
            <td><small title="${item.col1}">${item.col1.length > 40 ? item.col1.substring(0, 40) + '...' : item.col1}</small></td>
            <td><small title="${item.col2}">${item.col2.length > 40 ? item.col2.substring(0, 40) + '...' : item.col2}</small></td>
            <td class="text-end"><span class="badge bg-${countBadgeClass}">${item.count}</span></td>
        `;
        tbody.appendChild(row);
    });
}

function renderComplexPatternTable(tableId, patterns) {
    const table = document.getElementById(tableId);
    if (!table) return;

    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';

    // Convert patterns object to sorted array
    const items = Object.keys(patterns).map(key => {
        const [user, operation, ip] = key.split('|');
        return {
            user,
            operation,
            ip,
            count: patterns[key]
        };
    });

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3"><small>Aucun pattern détecté</small></td></tr>';
        return;
    }

    // Sort by count descending (top 50)
    items.sort((a, b) => b.count - a.count);
    items.slice(0, 50).forEach(item => {
        const row = document.createElement('tr');
        const countBadgeClass = item.count > 20 ? 'danger' : item.count > 10 ? 'warning' : 'info';
        const userDisplay = item.user.length > 25 ? item.user.substring(0, 25) + '...' : item.user;
        const ipDisplay = item.ip.length > 18 ? item.ip.substring(0, 18) + '...' : item.ip;
        row.innerHTML = `
            <td><small title="${item.user}">${userDisplay}</small></td>
            <td><small><span class="badge bg-secondary" title="${item.operation}">${item.operation.length > 30 ? item.operation.substring(0, 30) + '...' : item.operation}</span></small></td>
            <td><small title="${item.ip}">${ipDisplay}</small></td>
            <td class="text-end"><span class="badge bg-${countBadgeClass}">${item.count}</span></td>
        `;
        tbody.appendChild(row);
    });
}

function createOperationsChart(operations) {
    const ctx = document.getElementById('files-operations-chart');
    if (!ctx) return;

    // Destroy existing chart if it exists
    if (window.operationsChart) {
        window.operationsChart.destroy();
    }

    const labels = Object.keys(operations).slice(0, 15);
    const data = Object.values(operations).slice(0, 15);

    const colors = [
        '#0d6efd', '#6c757d', '#198754', '#dc3545', '#ffc107',
        '#0dcaf0', '#fd7e14', '#6f42c1', '#e83e8c', '#20c997',
        '#a5d8ff', '#e2e3e5', '#d1e7dd', '#f8d7da', '#fff3cd'
    ];

    window.operationsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Opérations',
                data: data,
                backgroundColor: colors.slice(0, labels.length),
                borderColor: colors.slice(0, labels.length),
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                    padding: 12,
                    titleFont: { size: 14 },
                    bodyFont: { size: 13 },
                    cornerRadius: 4
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        font: { size: 12 }
                    },
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)'
                    }
                },
                x: {
                    ticks: {
                        font: { size: 11 }
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

function showError(message) {
    const errorDiv = document.getElementById('upload-error');
    const errorMessage = document.getElementById('error-message');
    errorMessage.textContent = message;
    errorDiv.style.display = 'block';
}

function resetAnalysis() {
    currentSessionId = null;
    currentLogType = null;
    analysisData = {};

    // Reset form
    uploadForm.reset();
    document.getElementById('csv-check').style.display = 'none';
    document.getElementById('usermap-check').style.display = 'none';
    document.getElementById('file-info').style.display = 'none';
    document.getElementById('upload-error').style.display = 'none';

    // Show upload section
    uploadSection.style.display = 'block';
    dashboardSection.style.display = 'none';

    // Reset navbar
    navbarStatus.textContent = 'Bienvenue';

    // Reset file inputs
    csvFileInput.value = '';
}

function formatDate(dateString) {
    if (!dateString || dateString === '-' || dateString === '') return '-';
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('fr-FR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateString;
    }
}

// Fonctions de filtrage pour la chronologie
function applyTimelineFilters() {
    const filterIps = document.getElementById('filter-ips')?.value || '';
    const excludeIps = document.getElementById('exclude-ips')?.value || '';
    const filterUser = document.getElementById('filter-user')?.value || '';
    const filterOperation = document.getElementById('filter-operation')?.value || '';
    
    // Get the original operations (before any filtering)
    const originalOps = window.timelineOriginalOperations || window.timelineAllOperations || [];
    if (!originalOps || originalOps.length === 0) return;
    
    let filtered = originalOps.filter(op => {
        // Filtre IP à inclure - support multiple field names (client_ip, ClientIPAddress, ClientIP, SenderIp)
        if (filterIps) {
            const clientIp = op.ClientIP || op.client_ip || op.ClientIPAddress || op.SenderIp || '';
            if (!clientIp.includes(filterIps)) {
                return false;
            }
        }
        
        // Filtre IP à exclure - support multiple field names
        if (excludeIps) {
            const clientIp = op.ClientIP || op.client_ip || op.ClientIPAddress || op.SenderIp || '';
            if (clientIp.includes(excludeIps)) {
                return false;
            }
        }
        
        // Filtre utilisateur
        if (filterUser && !op.user?.toLowerCase().includes(filterUser.toLowerCase())) {
            return false;
        }
        
        // Filtre opération
        if (filterOperation && !op.operation?.toLowerCase().includes(filterOperation.toLowerCase())) {
            return false;
        }
        
        return true;
    });
    
    // Update the global operations to the filtered set
    window.timelineAllOperations = filtered;
    
    // Mettre à jour le tableau
    initializeTimelinePagination(filtered);
}

function resetTimelineFilters() {
    document.getElementById('filter-ips').value = '';
    document.getElementById('exclude-ips').value = '';
    document.getElementById('filter-user').value = '';
    document.getElementById('filter-operation').value = '';
    
    // Restore to original operations
    if (window.timelineOriginalOperations) {
        window.timelineAllOperations = window.timelineOriginalOperations;
        initializeTimelinePagination(window.timelineOriginalOperations);
    }
}

// Show details in modal
// Make table rows clickable
function makeRowsClickable(tableSelector, clickHandler) {
    const table = document.querySelector(tableSelector);
    if (!table) return;
    
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(row => {
        row.style.cursor = 'pointer';
        row.addEventListener('click', clickHandler);
        row.addEventListener('hover', function() {
            this.style.backgroundColor = '#f0f0f0';
        });
    });
}
